"""Отправка писем (приглашения). Если SMTP не настроен — письмо не уходит, и администратор передаёт ссылку сам."""
import smtplib
import ssl
from email.message import EmailMessage

from flask import current_app


def mail_configured() -> bool:
    c = current_app.config
    return bool(c["SMTP_HOST"] and (c["SMTP_FROM"] or c["SMTP_USER"]))


def send_mail(to: str, subject: str, text: str) -> bool:
    """True — письмо принято почтовым сервером. Ошибку не показываем посетителю, но и не теряем: пишем в журнал без пароля."""
    c = current_app.config
    if not mail_configured():
        return False
    msg = EmailMessage()
    msg["From"] = c["SMTP_FROM"] or c["SMTP_USER"]
    msg["To"] = to
    msg["Subject"] = subject
    msg.set_content(text)
    try:
        ctx = ssl.create_default_context()
        if c["SMTP_SSL"]:
            server = smtplib.SMTP_SSL(c["SMTP_HOST"], c["SMTP_PORT"], context=ctx, timeout=15)
        else:
            server = smtplib.SMTP(c["SMTP_HOST"], c["SMTP_PORT"], timeout=15)
            server.starttls(context=ctx)
        with server:
            if c["SMTP_USER"]:
                server.login(c["SMTP_USER"], c["SMTP_PASSWORD"])
            server.send_message(msg)
        return True
    except (smtplib.SMTPException, OSError) as e:
        current_app.logger.warning("Письмо на %s не отправлено: %s", to.split("@")[-1], type(e).__name__)
        return False
