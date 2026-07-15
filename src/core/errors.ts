/** Intentional, client-safe error types. The REST error handler maps these to
 *  status codes and surfaces their messages; everything else becomes a generic
 *  500 with no internal detail leaked. */

export class NotFoundError extends Error {
  constructor(what: string) {
    super(`${what} not found`);
    this.name = "NotFoundError";
  }
}
