/**
 * What this build is, and what it expects to talk to.
 *
 * `BUILD_ID` identifies the client for diagnosis: a report of "it went black"
 * is unactionable without it. `API_VERSION` is the contract the client was
 * compiled against - the server states its own, and a mismatch means someone
 * is running a cached build from before a breaking change and needs to
 * refresh rather than be left to fail in confusing ways.
 */

declare const __BUILD_ID__: string;
declare const __API_VERSION__: number;

export const BUILD_ID: string =
  typeof __BUILD_ID__ === "string" ? __BUILD_ID__ : "dev";

export const API_VERSION: number =
  typeof __API_VERSION__ === "number" ? __API_VERSION__ : 1;
