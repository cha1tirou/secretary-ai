export class GoogleApiError extends Error {
  public readonly status: number;
  public readonly userId: string;

  constructor(userId: string, message: string, status = 0) {
    super(message);
    this.name = "GoogleApiError";
    this.userId = userId;
    this.status = status;
  }
}
