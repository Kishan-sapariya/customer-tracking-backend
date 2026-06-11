// Typed application error. The error middleware turns this into the
// CRM-style `{ message }` envelope with the right status code (PRD §9.2).
export class ApiError extends Error {
  status: number;
  details?: unknown;

  constructor(status: number, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.details = details;
    this.name = "ApiError";
  }

  static badRequest(msg: string, details?: unknown) {
    return new ApiError(400, msg, details);
  }
  static unauthorized(msg = "Not authenticated") {
    return new ApiError(401, msg);
  }
  static forbidden(msg = "You don't have permission to do that") {
    return new ApiError(403, msg);
  }
  static notFound(msg = "Not found") {
    return new ApiError(404, msg);
  }
  static conflict(msg: string, details?: unknown) {
    return new ApiError(409, msg, details);
  }
}
