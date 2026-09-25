export interface ApiSuccessBody<T> {
  success: true;
  data: T;
}

export interface ApiErrorBody {
  success: false;
  message: string;
  code?: string;
  errors?: string[];
  data?: unknown;
  requestId?: string;
  timestamp: string;
  path: string;
}

export const ok = <T>(data: T): ApiSuccessBody<T> => ({ success: true, data });
