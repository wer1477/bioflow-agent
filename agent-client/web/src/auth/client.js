import { apiJson } from '../api.js';

/** 登录鉴权的 HTTP 客户端；端点契约见 docs/development.md。 */

export function fetchAuthMode() {
  return apiJson('/api/auth/mode');
}

export function fetchMe() {
  return apiJson('/api/auth/me');
}

export function login(email, password, remember) {
  return apiJson('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password, remember: Boolean(remember) }),
  });
}

export function register(email, password, code) {
  return apiJson('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({ email, password, code }),
  });
}

export function requestCode(email, purpose) {
  return apiJson('/api/auth/code', {
    method: 'POST',
    body: JSON.stringify({ email, purpose }),
  });
}

export function forgotPassword(email) {
  return apiJson('/api/auth/password/forgot', {
    method: 'POST',
    body: JSON.stringify({ email }),
  });
}

export function resetPassword(email, code, password) {
  return apiJson('/api/auth/password/reset', {
    method: 'POST',
    body: JSON.stringify({ email, code, password }),
  });
}

export function changePassword(currentPassword, newPassword) {
  return apiJson('/api/auth/password/change', {
    method: 'POST',
    body: JSON.stringify({ currentPassword, newPassword }),
  });
}

export function logout() {
  return apiJson('/api/auth/logout', { method: 'POST' });
}
