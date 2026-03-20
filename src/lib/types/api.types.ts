/**
 * Standard API response shape.
 * Every endpoint returns { status, data, message }.
 */
export interface ApiResponse<T> {
  status: number;
  data: T;
  message: string;
}
