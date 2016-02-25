var assert = require("assert");

var inherits = require("inherits");

var debug = require("../debug");
var log = require("../log");
var util = require("../util");
var WebSocket = require("../websocket");

var BaseConnectionDecorator = require("./base-connection-decorator");
var MessageBuffer = require("./message-buffer");

function generateId(size){
  var chars = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
  var id = '';
  for (var i=0; i < size; i++) {
    var rnum = Math.floor(Math.random() * chars.length);
    id += chars.substring(rnum,rnum+1);
  }
  return id;
};

// The job of this decorator is to serve as a "logical"
// connection that can survive the death of a "physical"
// connection, and restore the connection.
//
// * Reads from options: reconnectTimeout (in millis; <0 to disable)
// * Writes to ctx: nothing
// * Reads from ctx: nothing
exports.decorate = function(factory, options) {
  // Returns a connection promise
  return function(url, ctx, callback) {

    // The robustId is an id that will be shared by all
    // physical connections belonging to this logical
    // connection. We will include it in the URL.
    var robustId = generateId(18);

    var timeout = options.reconnectTimeout;
    if (typeof(timeout) === "undefined") {
      timeout = 15000;
    }

    var conn = new RobustConnection(timeout, factory, url, ctx, robustId);
    conn = new BufferedResendConnection(conn);
    callback(null, conn);
  };
};

// Utility function takes a (potentially still CONNECTING)
// connection, and returns a promise. The promise resolves
// successfully if onopen is called, and resolves as an
// error if onerror or onclose is called.
function promisify_p(conn) {

  var promise = util.promise();
  if (conn.readyState === WebSocket.OPEN) {
    promise(true, [conn]);
  } else if (conn.readyState === WebSocket.CLOSING || conn.readyState === WebSocket.CLOSED) {
    promise(false, [new Error("WebSocket was closed")]);
  } else if (conn.readyState === WebSocket.CONNECTING){
    conn.onopen = function() {
      conn.onopen = null;
      conn.onclose = null;
      conn.onerror = null;
      // PauseConnection helps avoid a race condition here. Between
      // conn.onopen being called and the promise resolution code
      // (onFulfilled/onRejected) being invoked, there's more than
      // enough time for onmessage/onerror/onclose events to occur.
      // You can see this if you have the server write a message
      // right away upon connection; that message will be dropped
      // because onmessage will be called before onFulfilled has
      // a chance to assign its onmessage callback. So we use a
      // paused connection that we can then resume() once all of
      // the appropriate callbacks are hooked up.
      //
      // There may still be a race condition in that the connection
      // might fire its onopen event between the time that the
      // factory creates it, and promisify_p is invoked. That at
      // least will manifest itself as a "stuck" connection, rather
      // than silently dropping a single message, which could be
      // much harder for the user to know that something is wrong.
      promise(true, [new util.PauseConnection(conn)]);
    };
    conn.onerror = function(e) {
      conn.onopen = null;
      conn.onclose = null;
      conn.onerror = null;
      promise(false, [new Error("WebSocket errored"), e]);
    };
    conn.onclose = function(e) {
      conn.onopen = null;
      conn.onclose = null;
      conn.onerror = null;
      promise(false, [new Error("WebSocket closed"), e]);
    };
  } else {
    throw new Error("Unexpected WebSocket readyState: " + conn.readyState);
  }

  return promise;
}

/*
Things that can move this robust connection into different states:

1) On construction, it's in CONNECTING.
2) On successful open of its first connection, it's OPEN.
3) On close() being called, it goes straight to CLOSED.
4) When a disconnect with !evt.wasClean occurs, attempt to
   reconnect; stay in OPEN. If we give up on this, then
   go to CLOSED.
5) When a wasClean disconnect occurs, go to CLOSED.
*/

function RobustConnection(timeout, factory, url, ctx, robustId) {
  this._timeout = timeout;
  this._factory = factory;
  this._url = url;
  this.url = url; // public version; overridden by physical connections
  this._ctx = ctx;
  this._robustId = robustId;
  this._conn = null;
  // Buffer messages here if connection is disconnected but may come back
  this._pendingMessages = [];
  this._stayClosed = false;

  // Initialize all event handlers to no-op.
  this.onopen = this.onclose = this.onerror = this.onmessage = function() {};

  // We'll need to carefully maintain the readyState manually.
  this._setReadyState(WebSocket.CONNECTING);
  this._connect(this._timeout);
}

RobustConnection.prototype._setReadyState = function(value) {
  if (typeof(this.readyState) !== "undefined" && this.readyState > value) {
    throw new Error("Invalid readyState transition: " + this.readyState + " to " + value);
  }
  this.readyState = value;
};

RobustConnection.prototype._acceptConn = function(conn) {

  // It's a programmer error to accept a connection while the previous
  // connection is still active...
  assert(!this._conn || this._conn.readyState > WebSocket.OPEN, "_acceptConn called while previous conn was still active");
  // ...or for the connection itself not to be open...
  assert(conn.readyState === WebSocket.OPEN, "_acceptConn called with non-open conn: " + conn.readyState);
  // ...or for the RobustConnection itself to be closed.
  assert(this.readyState === WebSocket.CONNECTING || this.readyState === WebSocket.OPEN, "_acceptConn called while readyState was " + this.readyState);

  this._conn = conn;
  // onopen intentionally not set; if we're here, we're
  // already in the OPEN state.
  this._conn.onclose = this._handleClose.bind(this);
  this._conn.onmessage = this._handleMessage.bind(this);
  this._conn.onerror = this._handleError.bind(this);
  this.protocol = conn.protocol;
  this.extensions = conn.extensions;
  this.url = conn.url;

  if (this.readyState === WebSocket.CONNECTING) {
    // This is our first time getting an open connection!
    // Transition to OPEN and let our clients know.
    this._setReadyState(WebSocket.OPEN);
    if (this.onopen)
      this.onopen(util.createEvent("open"));
  } else {
    log("Connection restored");

    // Otherwise, let our clients know that we've just reconnected.
    this.onreconnect(util.createEvent("reconnect"));
  }

  while (this._pendingMessages.length) {
    this.send(this._pendingMessages.shift());
  }
};

RobustConnection.prototype._clearConn = function() {
  if (this._conn) {
    this._conn.onopen = null;
    this._conn.onclose = null;
    this._conn.onerror = null;
    this._conn.onmessage = null;
    this._conn = null;
  }
};

// Call this when we don't have a connection (either we have never
// had one yet, or the last one we had is now closed and removed)
// but we want to get a new one.
RobustConnection.prototype._connect = function(timeoutMillis) {
  var self = this;

  assert(!self._conn, "_connect called but _conn is not null");
  assert(this.readyState <= WebSocket.OPEN, "_connect called from wrong readyState");

  // This function can be called repeatedly to get a connection promise.
  // Because it uses promisify_p, a successful resolve of the promise
  // means not only that the connection was created, but also entered
  // the WebSocket.OPEN state.
  function open_p() {
    var params = {};
    params[self.readyState === WebSocket.CONNECTING ? "n" : "o"] = self._robustId;
    var url = util.addPathParams(self._url, params);

    var promise = util.promise();
    self._factory(url, self._ctx, function(err, conn) {
      if (err) {
        promise(false, [err]);
        return;
      }

      promisify_p(conn).then(
        function() { promise(true, arguments); },
        function() { promise(false, arguments); }
      ).done();
    });
    return promise;
  }

  var expires = self.readyState !== WebSocket.OPEN ? 0 : Date.now() + timeoutMillis;

  util.retryPromise_p(open_p, util.createNiceBackoffDelayFunc(), expires).then(
    function(conn) {

      assert(!self._conn, "Connection promise fulfilled, but _conn was not null!");

      // If RobustConnection.close() was called in the
      // meantime, close the new conn and bail out.
      if (self.readyState === WebSocket.CLOSED) {
        conn.close();
        return;
      }

      self._acceptConn(conn);
      conn.resume();
    },
    function(err) {
      log(err);

      assert(!self._conn, "Connection promise rejected, but _conn was not null!");

      // If RobustConnection.close() was called in the
      // meantime, just get out of here.
      if (self.readyState === WebSocket.CLOSED) {
        return;
      }

      // If we're still waiting for the initial connection, we
      // want to raise an additional error event. (Is this
      // really necessary? I'm just guessing.)
      try {
        if (self.readyState === WebSocket.CONNECTING) {
          self.onerror(util.createEvent("error"));
        }
      } finally {
        // Whether onerror succeeds or not, we always want to close.
        // Note that code 1006 can't be passed to WebSocket.close (at
        // least on my Chrome install) but in this case we know for
        // sure there's no WebSocket to call close on--the connection
        // attempt failed, so this code will just be used to make an
        // event.
        self.close(1006, "", false);
      }
    }
  ).done();
};

RobustConnection.prototype._handleClose = function(e) {
  this._clearConn();
  // Use 4567 for interactive debugging purposes to trigger reconnect
  if ((e.code !== 4567) && e.wasClean || this._stayClosed) {
    // Apparently this closure was on purpose; don't try to reconnect
    this._setReadyState(WebSocket.CLOSED);
    this.onclose(e);
  } else {
    log("Disconnect detected; attempting reconnect");
    this.ondisconnect(util.createEvent("disconnect"));
    this._connect(this._timeout);
  }
};

// Event callback for this._conn.onmessage. Delegates to public
// member. We have to add this level of indirection to allow
// the value of this.onmessage to change over time.
RobustConnection.prototype._handleMessage = function(e) {
  if (this.onmessage)
    this.onmessage(e);
};
// Event callback for this._conn.onerror. Delegates to public
// member. We have to add this level of indirection to allow
// the value of this.onerror to change over time.
RobustConnection.prototype._handleError = function(e) {
  if (this.onerror)
    this.onerror(e);
};

RobustConnection.prototype.send = function(data) {
  if (this.readyState === WebSocket.CONNECTING) {
    throw new Error("Can't send when connection is in CONNECTING state");
  } else if (this.readyState > WebSocket.OPEN) {
    throw new Error("Connection is already CLOSING or CLOSED");
  }

  if (this._conn) {
    this._conn.send(data);
  } else {
    this._pendingMessages.push(data);
  }
};

RobustConnection.prototype.close = function(code, reason) {
  if (this.readyState === WebSocket.CLOSED) {
    return;
  }

  // Be careful!!

  if (this._conn) {
    // If a connection is currently active, we want to call close on
    // it and, for the most part, let nature take its course.

    // May throw, if code or reason are invalid. I'm assuming when
    // that happens, the conn isn't actually closed, so we need to
    // undo any side effects we have done before calling close().
    try {
      this._stayClosed = true; // Make sure not to reconnect
      this._conn.close(code, reason);
    } catch(e) {
      // Undo the setting of the flag.
      this._stayClosed = false;
      throw e;
    }

    // If _conn.close() hasn't triggered the _handleClose handler yet
    // (and I don't think it will have) then we need to mark ourselves
    // as CLOSING.
    this._setReadyState(Math.max(this.readyState, WebSocket.CLOSING));

  } else {

    // There's no active connection. Just immediately put us in closed
    // state and raise the event.
    this._setReadyState(WebSocket.CLOSED);
    if (this.onclose) {
      this.onclose(util.createEvent("close", {
        currentTarget: this, target: this, srcElement: this,
        code: code, reason: reason,
        wasClean: false
      }));
    }
  }
};


function BufferedResendConnection(conn) {
  BaseConnectionDecorator.call(this, conn);
  assert(this._conn);

  // This connection decorator is tightly coupled to RobustConnection
  assert(conn.constructor === RobustConnection);

  this._messageBuffer = new MessageBuffer();

  this._disconnected = false;

  conn.onopen = this._handleOpen.bind(this);
  conn.onmessage = this._handleMessage.bind(this);
  conn.onerror = this._handleError.bind(this);
  conn.onclose = this._handleClose.bind(this);

  // These two events are specific to RobustConnection. They
  // are used to detect potentially-temporary disruptions,
  // and successful recovery from those disruptions.
  conn.ondisconnect = this._handleDisconnect.bind(this);
  conn.onreconnect = this._handleReconnect.bind(this);
}

inherits(BufferedResendConnection, BaseConnectionDecorator);

BufferedResendConnection.prototype._handleDisconnect = function() {
  this._disconnected = true;
};
BufferedResendConnection.prototype._handleReconnect = function() {
  var self = this;
  this._conn.onmessage = function(e) {
    self._disconnected = false;
    self._conn.onmessage = self._handleMessage.bind(self);

    // If this is a proper, robustified connection, before we do
    // anything else we'll get a message indicating the most
    // recent message number seen + 1 (or 0 if none seen yet).
    try {
      var res = /^CONTINUE ([\dA-F]+)$/.exec(e.data);
      if (!res) {
        throw new Error("The RobustConnection handshake failed, CONTINUE expected");
      } else {
        // continueId represents the first id *not* seen by the server.
        // It might seem unintuitive to make it defined like that
        // rather than the last id seen by the server, but this allows
        // us to easily represent the case where the server has not
        // seen any messages (0) and also makes the iterating code here
        // a little cleaner.
        var continueId = parseInt(res[1], 16);
        debug("Discard and continue from message " + continueId);
        // Note: discard can throw
        self._messageBuffer.discard(continueId);
        // Note: getMessageFrom can throw
        var msgs = self._messageBuffer.getMessagesFrom(continueId);
        if (msgs.length > 0)
          debug(msgs.length + " messages were dropped; resending");
        msgs.forEach(function(msg) {
          // This msg is already formatted by MessageBuffer (tagged with id)
          self._conn.send(msg);
        });
      }
    } catch (e) {
      log("Error: RobustConnection handshake error: " + e);
      log(e.stack);
      self.close(3007, "RobustConnection handshake error: " + e);
    }
  };
};

BufferedResendConnection.prototype._handleMessage = function(e) {
  // At any time we can receive an ACK from the server that tells us
  // it's safe to discard existing messages.
  var ack = /^ACK ([\dA-F]+)$/.exec(e.data);
  if (ack) {
    // The message ID the server sends is the first id *not* seen by
    // the server (and not the last id seen by the server); see
    // MessageBuffer for the reason why.
    var msgId = parseInt(ack[1], 16);
    try {
      var dropCount = this._messageBuffer.discard(msgId);
      debug(dropCount + " message(s) discarded from buffer");
    } catch (e) {
      log("Error: ACK handling failed: " + e);
      log(e.stack);
      self.close(3008, "ACK handling failed: " + e);
    }

    // Don't allow clients to see this message, it's for our internal
    // consumption only.
    return;
  }

  if (this.onmessage) {
    this.onmessage.apply(this, arguments);
  }
};

BufferedResendConnection.prototype.send = function(data) {
  if (typeof(data) === "undefined" || data === null) {
    throw new Error("data argument must not be undefined or null");
  }

  // Write to the message buffer, and also save the return value which
  // is the message prepended with the id. This is what a compatible
  // server will expect to see.
  data = this._messageBuffer.write(data);

  // If not disconnected, attempt to send; otherwise, it's enough
  // that we wrote it to the buffer.
  if (!this._disconnected)
    this._conn.send(data);
};