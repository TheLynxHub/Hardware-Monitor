(function() {
	try {
		var e = "undefined" != typeof window ? window : "undefined" != typeof global ? global : "undefined" != typeof globalThis ? globalThis : "undefined" != typeof self ? self : {};
		e.SENTRY_RELEASE = { id: "ea803f2051806c332cf6a29b882a65ba1ae1bc76" };
		var n = new e.Error().stack;
		n && (e._sentryDebugIds = e._sentryDebugIds || {}, e._sentryDebugIds[n] = "c4b5d1b2-cd41-4a6e-8521-0febd6b65c0f", e._sentryDebugIdIdentifier = "sentry-dbid-c4b5d1b2-cd41-4a6e-8521-0febd6b65c0f");
	} catch (e) {}
})();
import { n as getSharedFromRuntime, r as importShared, t as getSharedFromLocal } from "./_virtual___federation_fn_import-DQkStKZl.js";
export { importShared, getSharedFromLocal as importSharedLocal, getSharedFromRuntime as importSharedRuntime };
