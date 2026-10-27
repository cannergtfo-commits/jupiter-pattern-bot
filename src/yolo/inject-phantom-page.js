/* eslint-disable */
/** Runs in the browser via Playwright addInitScript. Only receives publicKey. */
(function (pubkey) {
  try {
    var listeners = {};
    function on(ev, fn) {
      (listeners[ev] || (listeners[ev] = new Set())).add(fn);
    }
    function off(ev, fn) {
      if (listeners[ev]) listeners[ev].delete(fn);
    }
    function emit(ev) {
      var args = Array.prototype.slice.call(arguments, 1);
      var set = listeners[ev];
      if (!set) return;
      set.forEach(function (fn) {
        try {
          fn.apply(null, args);
        } catch (e) {}
      });
    }

    function b58Decode(b58) {
      var ALPH = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
      var map = {};
      for (var i = 0; i < ALPH.length; i++) map[ALPH[i]] = i;
      var bytesOut = [0];
      for (var ci = 0; ci < b58.length; ci++) {
        var carry = map[b58[ci]];
        if (carry === undefined) throw new Error("bad base58");
        for (var j = 0; j < bytesOut.length; j++) {
          carry += bytesOut[j] * 58;
          bytesOut[j] = carry & 0xff;
          carry >>= 8;
        }
        while (carry > 0) {
          bytesOut.push(carry & 0xff);
          carry >>= 8;
        }
      }
      var leading = 0;
      for (var k = 0; k < b58.length && b58[k] === "1"; k++) leading++;
      var rev = bytesOut.reverse();
      var out = new Uint8Array(leading + rev.length);
      for (var r = 0; r < rev.length; r++) out[leading + r] = rev[r];
      return out;
    }

    function makePk(b58) {
      var bytes = b58Decode(b58);
      return {
        toBase58: function () {
          return b58;
        },
        toString: function () {
          return b58;
        },
        toBytes: function () {
          return bytes;
        },
      };
    }

    function b64ToU8(b64) {
      var bin = atob(b64);
      var out = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return out;
    }
    function u8ToB64(u8) {
      var s = "";
      for (var i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
      return btoa(s);
    }

    var connected = false;
    var pk = makePk(pubkey);

    function signOne(tx) {
      var raw = tx.serialize({ requireAllSignatures: false, verifySignatures: false });
      return window.__yoloWalletSignTx(u8ToB64(raw)).then(function (signedB64) {
        var signed = b64ToU8(signedB64);
        var Ctor = tx.constructor;
        if (Ctor && typeof Ctor.deserialize === "function") return Ctor.deserialize(signed);
        if (Ctor && typeof Ctor.from === "function") return Ctor.from(signed);
        return {
          serialize: function () {
            return signed;
          },
        };
      });
    }

    var provider = {
      isPhantom: true,
      isYoloBot: true,
      get publicKey() {
        return connected ? pk : null;
      },
      connect: function (opts) {
        connected = true;
        emit("connect", pk);
        return Promise.resolve({ publicKey: pk });
      },
      disconnect: function () {
        connected = false;
        emit("disconnect");
        return Promise.resolve();
      },
      signTransaction: function (tx) {
        return signOne(tx);
      },
      signAllTransactions: function (txs) {
        var chain = Promise.resolve([]);
        txs.forEach(function (t) {
          chain = chain.then(function (arr) {
            return signOne(t).then(function (signed) {
              arr.push(signed);
              return arr;
            });
          });
        });
        return chain;
      },
      signAndSendTransaction: function (tx) {
        return signOne(tx).then(function () {
          return { signature: "1111111111111111111111111111111111111111111111111111111111111111" };
        });
      },
      signMessage: function (message) {
        return window.__yoloWalletSignMsg(u8ToB64(message)).then(function (sigB64) {
          return { signature: b64ToU8(sigB64), publicKey: pk };
        });
      },
      request: function (args) {
        if (args && args.method === "connect") return provider.connect(args.params);
        if (args && args.method === "disconnect") return provider.disconnect();
        return Promise.reject(new Error("Unsupported wallet method: " + (args && args.method)));
      },
      on: on,
      off: off,
      removeListener: off,
      get isConnected() {
        return connected;
      },
    };

    // Define before page scripts; re-assert after a tick in case frameworks overwrite
    function install() {
      try {
        Object.defineProperty(window, "solana", {
          configurable: true,
          writable: true,
          value: provider,
        });
      } catch (e) {
        window.solana = provider;
      }
      try {
        Object.defineProperty(window, "phantom", {
          configurable: true,
          writable: true,
          value: { solana: provider },
        });
      } catch (e) {
        window.phantom = { solana: provider };
      }
    }
    install();
    setInterval(function () {
      if (!window.solana || !window.solana.isYoloBot) install();
      if (!window.phantom || !window.phantom.solana || !window.phantom.solana.isYoloBot) install();
    }, 500);

    console.log("[yolo-inject] phantom window.solana ready", pubkey.slice(0, 8));
  } catch (e) {
    console.error("[yolo-inject] failed", e && e.message ? e.message : e);
  }
})
