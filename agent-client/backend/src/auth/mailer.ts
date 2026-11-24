import nodemailer from 'nodemailer';
import type { CodePurpose } from './types.js';
import type { SmtpConfig } from './config.js';
import { AuthError } from './errors.js';

export interface VerificationMailInput {
  to: string;
  code: string;
  purpose: CodePurpose;
  ttlMinutes: number;
}

export interface Mailer {
  sendVerificationCode(input: VerificationMailInput): Promise<void>;
}

export interface MemoryMailer extends Mailer {
  readonly messages: VerificationMailInput[];
  /** 最近一次验证码，测试用。 */
  lastCode(): string | null;
}

export function createMemoryMailer(): MemoryMailer {
  const messages: VerificationMailInput[] = [];
  return {
    messages,
    lastCode() {
      return messages.length ? messages[messages.length - 1].code : null;
    },
    async sendVerificationCode(input: VerificationMailInput) {
      messages.push({ ...input });
    },
  };
}

export function createNullMailer(): Mailer {
  return {
    async sendVerificationCode() {
      throw new AuthError(503, '邮件服务未配置，请联系管理员。');
    },
  };
}

export function createSmtpMailer(smtp: SmtpConfig): Mailer {
  const transport = nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.secure,
    auth: { user: smtp.user, pass: smtp.pass },
    // 服务器 hostname 不是 FQDN（the host），显式给 HELO 名避免被拒。
    name: 'bioflow.example.com',
  });

  return {
    async sendVerificationCode(input: VerificationMailInput) {
      const purposeLabel = input.purpose === 'register' ? '注册账号' : '重置密码';
      const subject = `Bioflow 验证码（${purposeLabel}）`;
      const text = [
        `您的 Bioflow 验证码是：${input.code}`,
        '',
        `用途：${purposeLabel}`,
        `有效期：${input.ttlMinutes} 分钟，请勿转发给他人。`,
        '',
        '如果这不是您本人的操作，请忽略本邮件。',
      ].join('\n');
      const html = [
        '<div style="font-family:system-ui,-apple-system,\'Segoe UI\',sans-serif;font-size:15px;color:#1f2328;line-height:1.6">',
        `<p>您的 Bioflow 验证码是：</p>`,
        `<p style="font-size:28px;font-weight:600;letter-spacing:6px;margin:12px 0">${input.code}</p>`,
        `<p>用途：${purposeLabel}；有效期 ${input.ttlMinutes} 分钟，请勿转发给他人。</p>`,
        '<p style="color:#6b7280">如果这不是您本人的操作，请忽略本邮件。</p>',
        '</div>',
      ].join('');
      await transport.sendMail({
        from: `"${smtp.fromName}" <${smtp.from}>`,
        to: input.to,
        subject,
        text,
        html,
      });
    },
  };
}
