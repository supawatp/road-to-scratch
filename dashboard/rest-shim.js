/* REST shim: implements the subset of window.claude.use("db") that the Road to Scratch page uses
   (collection().onSnapshot/add, doc().get/set/delete/onSnapshot) over /api/v1, so template.html runs unchanged.
   onSnapshot = fetch now + poll every 30 s (and right after every write, and when the tab becomes visible). */
(function () {
  "use strict";
  var POLL_MS = 30000;
  var API = "/api/v1/";
  var subs = [];

  function apiError(code, message) { var e = new Error(message || code); e.code = code; return e; }

  function request(method, path, body) {
    var opts = { method: method, credentials: "same-origin", headers: {} };
    if (body !== undefined) { opts.headers["Content-Type"] = "application/json"; opts.body = JSON.stringify(body); }
    return fetch(API + path, opts).then(function (r) {
      if (r.status === 401) { location.href = "/login"; throw apiError("unauthenticated"); }
      if (r.status === 404 && method === "GET") return null;
      if (r.status === 204) return null;
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok) throw apiError(j.code || (r.status === 400 ? "invalid_argument" : "unavailable"), j.error);
        return j;
      });
    });
  }

  function split(item) {
    var data = {};
    for (var k in item) if (k !== "id") data[k] = item[k];
    return { id: item.id, data: data };
  }
  function docSnapshot(id, data) {
    return { id: id, exists: data != null, data: function () { return data == null ? undefined : data; } };
  }
  function querySnapshot(items) {
    var docs = items.map(function (it) { var s = split(it); return docSnapshot(s.id, s.data); });
    return { docs: docs, size: docs.length, empty: docs.length === 0, forEach: function (fn) { docs.forEach(fn); } };
  }

  function poll(sub) {
    return request("GET", sub.path).then(function (res) {
      var key = JSON.stringify(res);
      if (key === sub.last) return;
      sub.last = key;
      if (sub.kind === "collection") sub.fn(querySnapshot((res && res.items) || []));
      else { var s = res ? split(res) : null; sub.fn(docSnapshot(sub.id, s ? s.data : null)); }
    }).catch(function (e) {
      if (sub.onError && !sub.failed) { sub.failed = true; sub.onError(e); }
    });
  }
  function refreshAll() { subs.forEach(poll); }
  function subscribe(kind, path, id, fn, onError) {
    var sub = { kind: kind, path: path, id: id, fn: fn, onError: onError, last: null };
    subs.push(sub);
    poll(sub);
    return function unsubscribe() { subs = subs.filter(function (s) { return s !== sub; }); };
  }
  setInterval(function () { if (!document.hidden) refreshAll(); }, POLL_MS);
  document.addEventListener("visibilitychange", function () { if (!document.hidden) refreshAll(); });

  function after(p) { return p.then(function (v) { refreshAll(); return v; }); }
  function enc(s) { return encodeURIComponent(s); }

  function docRef(coll, id) {
    var path = enc(coll) + "/" + enc(id);
    var readPath = path + "?missing=null";
    return {
      id: id,
      get: function () { return request("GET", readPath).then(function (r) { var s = r ? split(r) : null; return docSnapshot(id, s ? s.data : null); }); },
      set: function (data) { return after(request("PUT", path, data)); },
      update: function (data) {
        return request("GET", path).then(function (r) {
          var cur = r ? split(r).data : {};
          for (var k in data) cur[k] = data[k];
          return after(request("PUT", path, cur));
        });
      },
      delete: function () { return after(request("DELETE", path)); },
      onSnapshot: function (fn, onError) { return subscribe("doc", readPath, id, fn, onError); },
    };
  }
  function collectionRef(coll) {
    return {
      id: coll,
      doc: function (id) { return docRef(coll, id); },
      add: function (data) { return after(request("POST", enc(coll), data)).then(function (r) { return docRef(coll, r.id); }); },
      get: function () { return request("GET", enc(coll)).then(function (r) { return querySnapshot((r && r.items) || []); }); },
      onSnapshot: function (fn, onError) { return subscribe("collection", enc(coll), null, fn, onError); },
    };
  }
  function parsePath(p) { var parts = String(p).split("/"); return { coll: parts[0], id: parts.slice(1).join("/") }; }

  var db = {
    collection: function (name) { return collectionRef(name); },
    doc: function (path) { var p = parsePath(path); return docRef(p.coll, p.id); },
    // Plain API call for things outside the document model (SC4 upload, session tags).
    // body: string (sent as text/csv) or object (sent as JSON). Refreshes listeners afterwards.
    rpc: function (method, path, body) {
      if (typeof body !== "string") return after(request(method, path, body));
      return after(fetch(API + path, { method: method, credentials: "same-origin", headers: { "Content-Type": "text/csv" }, body: body })
        .then(function (r) {
          if (r.status === 401) { location.href = "/login"; throw apiError("unauthenticated"); }
          return r.json().catch(function () { return {}; }).then(function (j) { if (!r.ok) throw apiError(j.code || "unavailable", j.error); return j; });
        }));
    },
  };

  window.claude = window.claude || {};
  window.claude.use = function (name) { return Promise.resolve(name === "db" ? db : null); };
})();
