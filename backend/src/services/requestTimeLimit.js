// Node cuts off a request still arriving after server.requestTimeout (five minutes by default).
// An upload that is read only as fast as it is processed (a backup restore, a mail import) can
// take longer, so it lifts the limit for as long as it runs. The limit is the server's, not the
// request's, so overlapping uploads share one lift: the limit comes back when the last one ends.
const lifts = new WeakMap();

export function liftRequestTimeout(server) {
  if (!server) return () => {};
  let lift = lifts.get(server);
  if (!lift) {
    lift = { count: 0, saved: server.requestTimeout };
    lifts.set(server, lift);
  }
  lift.count++;
  server.requestTimeout = 0;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--lift.count === 0) {
      server.requestTimeout = lift.saved;
      lifts.delete(server);
    }
  };
}
