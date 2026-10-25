"""Сброс пароля, если его забыли (запускается на сервере, где лежит база):

    python reset_password.py                      — администратор из ADMIN_EMAIL (admin@arena.local)
    python reset_password.py ivan@example.com     — любая учётная запись

Придумывает новый надёжный пароль, снимает блокировку и включает запись, завершает все сеансы
(старые токены перестают работать). Новый пароль печатается здесь и, для администратора по умолчанию,
сохраняется в data/admin-password.txt. В журнал действий пишется событие password_change.
"""
import sys

from app import config
from app import new_password, save_admin_password
from app.db import connect, migrate, now
from app.security import hash_password


def main() -> int:
    cfg = config.load()
    email = (sys.argv[1] if len(sys.argv) > 1 else cfg["ADMIN_EMAIL"]).strip().lower()
    con = connect(cfg["DB_PATH"])
    migrate(con)
    u = con.execute("SELECT id, email, role FROM users WHERE email = ?", (email,)).fetchone()
    if not u:
        print(f"Учётной записи {email} нет. Есть: " + ", ".join(r["email"] for r in con.execute("SELECT email FROM users ORDER BY id")))
        return 1
    pw = new_password()
    con.execute("""UPDATE users SET password_hash = ?, password_changed_at = ?, token_version = token_version + 1,
                   failed_logins = 0, locked_until = NULL, is_active = 1 WHERE id = ?""", (hash_password(pw), now(), u["id"]))
    con.execute("INSERT INTO audit_events (user_id, action, details, ip, created_at) VALUES (?, 'password_change', ?, 'local', ?)",
                (u["id"], "сброс через reset_password.py", now()))
    con.commit()
    con.close()
    where = save_admin_password(cfg, u["email"], pw) if u["email"] == cfg["ADMIN_EMAIL"].lower() else None
    print(f"Новый пароль для {u['email']} ({u['role']}): {pw}")
    if where:
        print(f"Сохранён в {where}")
    print("Все прежние сеансы завершены. После входа смените пароль в личном кабинете.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
