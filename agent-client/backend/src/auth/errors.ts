/** 鉴权层可预期的失败：带 HTTP 状态码，router 统一转成 `{error}` 响应。 */
export class AuthError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'AuthError';
  }
}
