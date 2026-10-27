(function () {
  try {
    var pubkey = localStorage.getItem("__yolo_bot_pubkey") || "";
    if (!pubkey) {
      // Placeholder until Playwright sets pubkey + reloads; still mark isPhantom so adapter detects install
      pubkey = "11111111111111111111111111111111";
    }
    if (window.solana && window.solana.isYoloBot) return;

    var connected = false;
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
    var pk = {
      toString: function () { return pubkey; },
      toBase58: function () { return pubkey; },
      toBytes: function () { return new TextEncoder().encode(pubkey); },
    };
    var listeners = {};
    function on(ev, fn) { (listeners[ev] || (listeners[ev] = [])).push(fn); }
    function emit(ev, a) { (listeners[ev] || []).forEach(function (fn) { try { fn(a); } catch (e) {} }); }

    var provider = {
      isPhantom: true,
      isYoloBot: true,
      get publicKey() { return connected ? pk : null; },
      connect: async function () {
        connected = true;
        emit("connect", pk);
        return { publicKey: pk };
      },
      disconnect: async function () { connected = false; emit("disconnect"); },
      signTransaction: async function (tx) {
        if (!window.__yoloWalletSignTx) throw new Error("YOLO sign bridge missing");
        var raw = tx.serialize({ requireAllSignatures: false, verifySignatures: false });
        var signedB64 = await window.__yoloWalletSignTx(u8ToB64(raw));
        var signed = b64ToU8(signedB64);
        var Ctor = tx.constructor;
        if (Ctor && Ctor.deserialize) return Ctor.deserialize(signed);
        if (Ctor && Ctor.from) return Ctor.from(signed);
        return { serialize: function () { return signed; } };
      },
      signAllTransactions: async function (txs) {
        var out = [];
        for (var i = 0; i < txs.length; i++) out.push(await provider.signTransaction(txs[i]));
        return out;
      },
      signMessage: async function (message) {
        if (!window.__yoloWalletSignMsg) throw new Error("YOLO sign bridge missing");
        var sigB64 = await window.__yoloWalletSignMsg(u8ToB64(message));
        return { signature: b64ToU8(sigB64), publicKey: pk };
      },
      on: on,
      off: function () {},
      request: async function (args) {
        if (args.method === "connect") return provider.connect();
        throw new Error("unsupported");
      },
      get isConnected() { return connected; },
    };
    Object.defineProperty(window, "solana", { configurable: true, writable: true, value: provider });
    Object.defineProperty(window, "phantom", { configurable: true, writable: true, value: { solana: provider } });
    console.log("[yolo-ext] phantom shim installed", pubkey.slice(0, 8));
  } catch (e) {
    console.error("[yolo-ext] fail", e);
  }
})();
