const nodemailer = require('nodemailer');
const dns = require('dns');

function isTrue(value) {
  return /^(1|true|yes)$/i.test(String(value || ''));
}

function createEmailService(env = process.env) {
  const host = String(env.SMTP_HOST || '').trim();
  const port = Number(env.SMTP_PORT || 0);
  const user = String(env.SMTP_USER || '').trim();
  const password = String(env.SMTP_PASSWORD || '');
  const from = String(env.SMTP_FROM || '').trim();

  function isConfigured() {
    return Boolean(host && port > 0 && port <= 65535 && user && password && from);
  }

  async function sendVerificationCode({ to, code, purpose }) {
    if (!isConfigured()) {
      const error = new Error('邮箱服务尚未配置');
      error.code = 'EMAIL_NOT_CONFIGURED';
      throw error;
    }
    const isReset = purpose === 'password_reset';
    const action = isReset ? '重置密码' : '完成注册';
    const { address } = await dns.promises.lookup(host, { family: 4 });
    const transporter = nodemailer.createTransport({
      host: address,
      port,
      secure: isTrue(env.SMTP_SECURE),
      auth: { user, pass: password },
      connectionTimeout: 8000,
      greetingTimeout: 8000,
      socketTimeout: 12000,
      tls: { servername: host },
    });
    await transporter.sendMail({
      from,
      to,
      subject: `【茉莉妈妈】${action}验证码`,
      text: `您的验证码是 ${code}，10 分钟内有效。若非本人操作，请忽略本邮件。`,
      html: `<p>您的验证码是：</p><p style="font-size:28px;font-weight:700;letter-spacing:6px">${code}</p><p>10 分钟内有效。若非本人操作，请忽略本邮件。</p>`,
    });
  }

  return { isConfigured, sendVerificationCode };
}

module.exports = { createEmailService };
