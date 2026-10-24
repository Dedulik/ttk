"""Запуск: python -m unittest discover -s tests  (из папки backend)."""
import io
import tempfile
import unittest
from pathlib import Path

from app import create_app

SLUG = "rostov-arena"


def png_header(w, h):
    """Минимальный PNG-заголовок с нужным размером — серверу достаточно сигнатуры и IHDR."""
    return b"\x89PNG\r\n\x1a\n" + b"\x00\x00\x00\rIHDR" + w.to_bytes(4, "big") + h.to_bytes(4, "big") + b"\x08\x06\x00\x00\x00" + b"0" * 16


class ApiTest(unittest.TestCase):
    def setUp(self):
        tmp = Path(tempfile.mkdtemp())
        self.app = create_app({"DB_PATH": str(tmp / "t.db"), "UPLOAD_DIR": str(tmp / "up"), "SECRET_KEY": "test-secret-key-for-unit-tests-only"})
        from app import security
        security._ip_fails.clear()   # счётчик неудачных входов общий на процесс
        self.c = self.app.test_client()

    def login(self, email, pw):
        r = self.c.post("/api/auth/login", json={"email": email, "password": pw})
        self.assertEqual(r.status_code, 200, r.get_json())
        return {"Authorization": "Bearer " + r.get_json()["token"]}

    def test_roles_and_publishing(self):
        c = self.c
        self.assertEqual(c.get("/api/health").get_json(), {"ok": True})
        # посетитель без входа видит опубликованную версию, но не черновик
        self.assertEqual(c.get(f"/api/venues/{SLUG}/map").get_json()["number"], 1)
        self.assertEqual(c.get(f"/api/venues/{SLUG}/draft").status_code, 401)
        self.assertEqual(c.post("/api/auth/login", json={"email": "admin@arena.local", "password": "x"}).status_code, 401)

        viewer = self.login("viewer@arena.local", "viewer12345")
        editor = self.login("editor@arena.local", "editor12345")
        admin = self.login("ADMIN@arena.local", "admin12345")  # почта без учёта регистра
        self.assertEqual(c.get("/api/auth/me", headers=admin).get_json()["role"], "admin")

        d = c.get(f"/api/venues/{SLUG}/draft", headers=viewer).get_json()
        data, rev = d["data"], d["revision"]
        data["pois"].append({"id": "t1", "name": "Тест", "cat": "info", "x": 1, "y": 1, "text": ""})

        self.assertEqual(c.put(f"/api/venues/{SLUG}/draft", json={"data": data, "base_revision": rev}, headers=viewer).status_code, 403)
        r = c.put(f"/api/venues/{SLUG}/draft", json={"data": data, "base_revision": rev}, headers=editor)
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.get_json()["revision"], rev + 1)
        self.assertEqual(r.get_json()["updated_by"], "Редактор")
        # устаревшая ревизия → конфликт, битые данные → 422
        self.assertEqual(c.put(f"/api/venues/{SLUG}/draft", json={"data": data, "base_revision": rev}, headers=editor).status_code, 409)
        bad = dict(data, links=[["p1", "nope"]])
        self.assertEqual(c.put(f"/api/venues/{SLUG}/draft", json={"data": bad, "base_revision": rev + 1}, headers=editor).status_code, 422)
        dup = dict(data, pois=data["pois"] + [data["pois"][0]])
        self.assertEqual(c.put(f"/api/venues/{SLUG}/draft", json={"data": dup, "base_revision": rev + 1}, headers=editor).status_code, 422)

        # публикует только администратор
        self.assertEqual(c.post(f"/api/venues/{SLUG}/publish", json={}, headers=editor).status_code, 403)
        v = c.post(f"/api/venues/{SLUG}/publish", json={"comment": "Метка теста"}, headers=admin).get_json()
        self.assertEqual(v["number"], 2)
        self.assertTrue(any(p["id"] == "t1" for p in c.get(f"/api/venues/{SLUG}/map").get_json()["data"]["pois"]))

        # откат версии 1 в черновик
        v1 = [x for x in c.get(f"/api/venues/{SLUG}/versions", headers=viewer).get_json() if x["number"] == 1][0]
        self.assertEqual(c.post(f"/api/venues/{SLUG}/versions/{v1['id']}/restore", headers=editor).status_code, 403)
        r = c.post(f"/api/venues/{SLUG}/versions/{v1['id']}/restore", headers=admin).get_json()
        self.assertFalse(any(p["id"] == "t1" for p in r["data"]["pois"]))

    def test_users_admin_only(self):
        c = self.c
        editor = self.login("editor@arena.local", "editor12345")
        admin = self.login("admin@arena.local", "admin12345")
        self.assertEqual(c.get("/api/users", headers=editor).status_code, 403)
        self.assertEqual(c.post("/api/users", json={"email": "weak@arena.local", "password": "secret1"}, headers=admin).status_code, 422)
        r = c.post("/api/users", json={"email": "new@arena.local", "password": "secret123", "role": "viewer"}, headers=admin)
        self.assertEqual(r.status_code, 201)
        uid = r.get_json()["id"]
        self.assertEqual(c.post("/api/users", json={"email": "new@arena.local", "password": "secret123"}, headers=admin).status_code, 409)
        self.assertEqual(c.patch(f"/api/users/{uid}", json={"role": "editor"}, headers=admin).get_json()["role"], "editor")
        new = self.login("new@arena.local", "secret123")
        self.assertEqual(c.get(f"/api/venues/{SLUG}/draft", headers=new).status_code, 200)
        # понижение роли действует сразу, без перевыпуска токена
        c.patch(f"/api/users/{uid}", json={"role": "viewer"}, headers=admin)
        d = c.get(f"/api/venues/{SLUG}/draft", headers=new).get_json()
        self.assertEqual(c.put(f"/api/venues/{SLUG}/draft", json={"data": d["data"], "base_revision": d["revision"]}, headers=new).status_code, 403)
        # последнего админа не понизить и не удалить
        me = c.get("/api/auth/me", headers=admin).get_json()
        self.assertEqual(c.patch(f"/api/users/{me['id']}", json={"role": "editor"}, headers=admin).status_code, 400)
        self.assertEqual(c.delete(f"/api/users/{uid}", headers=admin).status_code, 204)

    def test_uploads_and_site(self):
        c = self.c
        editor = self.login("editor@arena.local", "editor12345")
        viewer = self.login("viewer@arena.local", "viewer12345")
        png = png_header(64, 48)
        r = c.post("/api/uploads", data={"file": (io.BytesIO(png), "a.png", "image/png")}, headers=editor, content_type="multipart/form-data")
        self.assertEqual(r.status_code, 201)
        self.assertEqual(c.get(r.get_json()["url"]).status_code, 200)
        fake = c.post("/api/uploads", data={"file": (io.BytesIO(b"<html>"), "a.png", "image/png")}, headers=editor, content_type="multipart/form-data")
        self.assertEqual(fake.status_code, 415)
        self.assertEqual(c.post("/api/uploads", data={"file": (io.BytesIO(png), "a.png", "image/png")}, headers=viewer, content_type="multipart/form-data").status_code, 403)
        self.assertEqual(c.get("/").status_code, 200)
        page = c.get("/admin")
        self.assertEqual(page.status_code, 200)
        self.assertIn(b"admin-main.js", page.data)
        self.assertIn("script-src 'self' 'sha256-", page.headers["Content-Security-Policy"])
        self.assertEqual(page.headers["X-Content-Type-Options"], "nosniff")
        self.assertEqual(c.get("/api/nothing").status_code, 404)

    def test_login_protection_and_cabinet(self):
        c = self.c
        for _ in range(5):
            self.assertEqual(c.post("/api/auth/login", json={"email": "editor@arena.local", "password": "wrong"}).status_code, 401)
        # после пяти ошибок не пускает даже с верным паролем, пока админ не разблокирует
        self.assertEqual(c.post("/api/auth/login", json={"email": "editor@arena.local", "password": "editor12345"}).status_code, 423)
        admin = self.login("admin@arena.local", "admin12345")
        ed = [u for u in c.get("/api/users", headers=admin).get_json() if u["email"] == "editor@arena.local"][0]
        self.assertTrue(ed["locked"])
        c.patch(f"/api/users/{ed['id']}", json={"unlock": True}, headers=admin)
        editor = self.login("editor@arena.local", "editor12345")

        # смена пароля в кабинете: нужен текущий, старые сессии отзываются
        other = self.login("editor@arena.local", "editor12345")
        self.assertEqual(c.patch("/api/auth/me", json={"password": "nope", "new_password": "newpass123"}, headers=editor).status_code, 403)
        r = c.patch("/api/auth/me", json={"name": "Ксения", "password": "editor12345", "new_password": "newpass123"}, headers=editor).get_json()
        self.assertEqual(r["user"]["name"], "Ксения")
        self.assertEqual(c.get("/api/auth/me", headers=other).status_code, 401)
        fresh = {"Authorization": "Bearer " + r["token"]}
        self.assertEqual(c.get("/api/auth/me", headers=fresh).status_code, 200)
        self.assertTrue(any(a["action"] == "password_change" for a in c.get("/api/auth/me/activity", headers=fresh).get_json()))

        # отключённый сотрудник сразу теряет доступ
        c.patch(f"/api/users/{ed['id']}", json={"is_active": False}, headers=admin)
        self.assertEqual(c.get("/api/auth/me", headers=fresh).status_code, 401)

        # журнал, отчёт и резервная копия — только админу
        self.assertEqual(c.get("/api/admin/audit", headers=fresh).status_code, 401)
        self.assertTrue(any(a["action"] == "account_locked" for a in c.get("/api/admin/audit", headers=admin).get_json()))
        rep = c.get("/api/admin/security", headers=admin).get_json()
        self.assertIn("admin@arena.local", rep["default_passwords"])
        b = c.get("/api/admin/backup", headers=admin)
        self.assertEqual(b.status_code, 200)
        self.assertTrue(b.data.startswith(b"SQLite format 3"))
        b.close()

    def test_edit_lock(self):
        """В объекте редактирует один человек; второй видит, кто занят, и не может сохранить, пока замок не снят."""
        c = self.c
        editor = self.login("editor@arena.local", "editor12345")
        admin = self.login("admin@arena.local", "admin12345")
        self.assertTrue(c.post(f"/api/venues/{SLUG}/lock", headers=editor).get_json()["mine"])
        busy = c.post(f"/api/venues/{SLUG}/lock", headers=admin).get_json()
        self.assertFalse(busy["mine"])
        self.assertEqual(busy["holder"]["name"], "Редактор")
        d = c.get(f"/api/venues/{SLUG}/draft", headers=admin).get_json()
        self.assertEqual(d["venue"]["lock"]["name"], "Редактор")
        self.assertEqual(c.put(f"/api/venues/{SLUG}/draft", json={"data": d["data"], "base_revision": d["revision"]}, headers=admin).status_code, 423)
        self.assertEqual(c.post(f"/api/venues/{SLUG}/publish", json={}, headers=admin).status_code, 423)
        # хозяин замка сохраняет — ревизия растёт, второй увидит её при следующем опросе
        r = c.put(f"/api/venues/{SLUG}/draft", json={"data": d["data"], "base_revision": d["revision"]}, headers=editor)
        self.assertEqual(r.status_code, 200)
        self.assertEqual(c.get(f"/api/venues/{SLUG}/draft", headers=admin).get_json()["revision"], d["revision"] + 1)
        # вышел из конструктора — объект свободен
        self.assertEqual(c.delete(f"/api/venues/{SLUG}/lock", headers=editor).status_code, 204)
        self.assertTrue(c.post(f"/api/venues/{SLUG}/lock", headers=admin).get_json()["mine"])
        # брошенный замок (вкладку закрыли без выхода) истекает сам
        from app.db import connect
        con = connect(self.app.config["DB_PATH"]); con.execute("UPDATE venue_locks SET seen = '2000-01-01T00:00:00+00:00'"); con.commit(); con.close()
        self.assertTrue(c.post(f"/api/venues/{SLUG}/lock", headers=editor).get_json()["mine"])

    def test_venues_constructor(self):
        c = self.c
        editor = self.login("editor@arena.local", "editor12345")
        admin = self.login("admin@arena.local", "admin12345")
        self.assertEqual(c.post("/api/venues", json={"name": "Склад"}, headers=editor).status_code, 403)
        r = c.post("/api/venues", json={"name": "Торговый центр", "width": 300, "height": 150}, headers=admin)
        self.assertEqual(r.status_code, 201, r.get_json())
        slug = r.get_json()["slug"]
        self.assertEqual(slug, "torgovyy-tsentr")
        d = c.get(f"/api/venues/{slug}/draft", headers=editor).get_json()
        self.assertIsNone(d["data"]["stadium"])
        self.assertEqual(d["data"]["shapes"][0]["w"], 300)
        # посетители не видят объект, пока его не опубликовали
        self.assertEqual(c.get(f"/api/venues/{slug}/map").status_code, 404)
        self.assertNotIn(slug, [v["slug"] for v in c.get("/api/venues").get_json()])
        self.assertIn(slug, [v["slug"] for v in c.get("/api/venues", headers=editor).get_json()])
        c.post(f"/api/venues/{slug}/publish", json={}, headers=admin)
        self.assertEqual(c.get(f"/api/venues/{slug}/map").get_json()["venue"]["name"], "Торговый центр")
        # личная ссылка администратора: посетитель видит только его опубликованные объекты
        by = c.get("/api/venues/by/admin").get_json()
        self.assertEqual(sorted(v["slug"] for v in by["venues"]), sorted([SLUG, slug, "manezh-dgtu"]))
        self.assertEqual(c.patch("/api/auth/me", json={"handle": "Плохой адрес"}, headers=admin).status_code, 422)
        self.assertEqual(c.patch("/api/auth/me", json={"handle": "editor"}, headers=admin).status_code, 409)
        c.patch("/api/auth/me", json={"handle": "ivan-arena"}, headers=admin)
        self.assertEqual(c.get("/api/venues/by/admin").status_code, 404)
        self.assertEqual(len(c.get("/api/venues/by/ivan-arena").get_json()["venues"]), 3)
        # копия и удаление с подтверждением
        cp = c.post("/api/venues", json={"name": "Копия", "start": "copy", "source": SLUG}, headers=admin).get_json()
        self.assertEqual(c.delete(f"/api/venues/{cp['slug']}", json={}, headers=admin).status_code, 422)
        self.assertEqual(c.delete(f"/api/venues/{cp['slug']}", json={"confirm": cp["slug"]}, headers=admin).status_code, 204)
        self.assertEqual(c.get(f"/api/venues/{cp['slug']}/map").status_code, 404)

    def test_registration_cannot_grant_admin(self):
        """Регистрация даёт только роль «посетитель»; попытки подсунуть роль игнорируются, к админке и черновикам доступа нет."""
        c = self.c
        r = c.post("/api/auth/register", json={"email": "Guest@Mail.ru", "name": "Гость", "password": "guestpass1", "role": "admin", "is_admin": True})
        self.assertEqual(r.status_code, 201, r.get_json())
        self.assertEqual(r.get_json()["user"]["role"], "user")
        guest = {"Authorization": "Bearer " + r.get_json()["token"]}
        self.assertEqual(c.get("/api/auth/me", headers=guest).get_json()["email"], "guest@mail.ru")
        for method, url in (("get", f"/api/venues/{SLUG}/draft"), ("get", "/api/users"), ("post", "/api/invites"), ("get", "/api/admin/audit"), ("post", f"/api/venues/{SLUG}/lock")):
            self.assertIn(getattr(c, method)(url, headers=guest, json={}).status_code, (401, 403), url)
        # повысить себя через «изменение профиля» тоже нельзя
        c.patch("/api/auth/me", json={"role": "admin", "name": "Гость"}, headers=guest)
        self.assertEqual(c.get("/api/auth/me", headers=guest).get_json()["role"], "user")
        # повтор почты, слабый пароль, бот-ловушка
        self.assertEqual(c.post("/api/auth/register", json={"email": "guest@mail.ru", "name": "Ещё", "password": "guestpass1"}).status_code, 409)
        self.assertEqual(c.post("/api/auth/register", json={"email": "x@mail.ru", "name": "Икс", "password": "123"}).status_code, 422)
        self.assertEqual(c.post("/api/auth/register", json={"email": "bot@mail.ru", "name": "Бот", "password": "botpass123", "website": "spam"}).status_code, 400)
        # с одного адреса — не больше 5 регистраций в час
        codes = [c.post("/api/auth/register", json={"email": f"u{i}@mail.ru", "name": "Пользователь", "password": "userpass1"}).status_code for i in range(6)]
        self.assertIn(429, codes)

    def test_admin_invites(self):
        c = self.c
        admin = self.login("admin@arena.local", "admin12345")
        editor = self.login("editor@arena.local", "editor12345")
        # приглашать может только администратор
        self.assertEqual(c.post("/api/invites", json={"email": "new.admin@arena.local", "role": "admin"}, headers=editor).status_code, 403)
        self.assertEqual(c.post("/api/invites", json={"email": "x@arena.local", "role": "superuser"}, headers=admin).status_code, 422)
        r = c.post("/api/invites", json={"email": "new.admin@arena.local", "role": "admin"}, headers=admin)
        self.assertEqual(r.status_code, 201, r.get_json())
        body = r.get_json()
        self.assertFalse(body["emailed"])                 # SMTP в тестах не настроен — ссылку получает админ
        token = body["link"].split("#/invite/")[1]
        # в базе — только хэш токена
        from app.db import connect
        con = connect(self.app.config["DB_PATH"])
        self.assertIsNone(con.execute("SELECT 1 FROM invites WHERE token_hash = ?", (token,)).fetchone())
        con.close()
        self.assertEqual(c.get("/api/invites/accept/wrong-token").status_code, 404)
        info = c.get(f"/api/invites/accept/{token}").get_json()
        self.assertEqual((info["email"], info["role"], info["exists"]), ("new.admin@arena.local", "admin", False))
        # роль из запроса игнорируется — берётся из приглашения
        acc = c.post(f"/api/invites/accept/{token}", json={"name": "Новый админ", "password": "newadmin123", "role": "user"})
        self.assertEqual(acc.status_code, 200, acc.get_json())
        self.assertEqual(acc.get_json()["user"]["role"], "admin")
        # одноразовое
        self.assertEqual(c.post(f"/api/invites/accept/{token}", json={"name": "Ещё раз", "password": "newadmin123"}).status_code, 410)
        # посетитель повышается до редактора только с паролем своей учётной записи
        c.post("/api/auth/register", json={"email": "guest2@mail.ru", "name": "Гость", "password": "guestpass1"})
        t2 = c.post("/api/invites", json={"email": "guest2@mail.ru", "role": "editor"}, headers=admin).get_json()["link"].split("#/invite/")[1]
        self.assertTrue(c.get(f"/api/invites/accept/{t2}").get_json()["exists"])
        self.assertEqual(c.post(f"/api/invites/accept/{t2}", json={"password": "wrong"}).status_code, 403)
        self.assertEqual(c.post(f"/api/invites/accept/{t2}", json={"password": "guestpass1"}).get_json()["user"]["role"], "editor")
        # истёкшее и отозванное приглашения не работают
        t3 = c.post("/api/invites", json={"email": "late@arena.local", "role": "viewer"}, headers=admin).get_json()["link"].split("#/invite/")[1]
        con = connect(self.app.config["DB_PATH"])
        con.execute("UPDATE invites SET expires_at = '2000-01-01T00:00:00+00:00' WHERE email = 'late@arena.local'")
        con.commit(); con.close()
        self.assertEqual(c.get(f"/api/invites/accept/{t3}").status_code, 410)
        inv = c.post("/api/invites", json={"email": "rev@arena.local", "role": "viewer"}, headers=admin).get_json()
        c.delete(f"/api/invites/{inv['invite']['id']}", headers=admin)
        self.assertEqual(c.get("/api/invites/accept/" + inv["link"].split("#/invite/")[1]).status_code, 410)
        self.assertTrue(any(i["state"] == "used" for i in c.get("/api/invites", headers=admin).get_json()))

    def test_map_sanitizing_and_quest(self):
        c = self.c
        admin = self.login("admin@arena.local", "admin12345")
        d = c.get(f"/api/venues/{SLUG}/draft", headers=admin).get_json()
        data, rev = d["data"], d["revision"]
        data["pois"] += [
            {"id": "x1", "name": "<img src=x onerror=alert(1)>", "cat": "info", "x": 1, "y": 1, "photo": "javascript:alert(1)", "color": "red;}<script>"},
            {"id": "q1", "name": "Пиксель", "cat": "quest", "x": 5, "y": 5}, {"id": "q2", "name": "Пиксель 2", "cat": "quest", "x": 6, "y": 6},
        ]
        data["panos"][0]["embed"] = '"><script>alert(1)</script>'
        data["panos"][0]["videos"] = {"x": "javascript:alert(1)", "y": "/uploads/" + "a" * 32 + ".mp4"}
        r = c.put(f"/api/venues/{SLUG}/draft", json={"data": data, "base_revision": rev}, headers=admin)
        self.assertEqual(r.status_code, 200, r.get_json())
        saved = r.get_json()["data"]
        x1 = [p for p in saved["pois"] if p["id"] == "x1"][0]
        self.assertNotIn("photo", x1)                    # опасная ссылка не сохранилась
        self.assertNotIn("color", x1)
        self.assertNotIn("embed", saved["panos"][0])
        self.assertEqual(saved["panos"][0]["videos"], {"y": "/uploads/" + "a" * 32 + ".mp4"})
        self.assertEqual(x1["name"], "<img src=x onerror=alert(1)>")   # текст хранится как есть — экранируется при выводе
        bad = dict(saved, pois=saved["pois"] + [{"id": 'bad id"', "name": "x", "cat": "info", "x": 0, "y": 0}])
        self.assertEqual(c.put(f"/api/venues/{SLUG}/draft", json={"data": bad, "base_revision": r.get_json()["revision"]}, headers=admin).status_code, 422)
        c.post(f"/api/venues/{SLUG}/publish", json={}, headers=admin)
        # охота: засчитываются только настоящие пиксели с опубликованной карты
        reg = c.post("/api/auth/register", json={"email": "hunter@mail.ru", "name": "Охотник", "password": "hunter123"}).get_json()
        h = {"Authorization": "Bearer " + reg["token"]}
        self.assertEqual(c.post(f"/api/quest/{SLUG}/found", json={"items": ["q1"]}).status_code, 401)
        res = c.post(f"/api/quest/{SLUG}/found", json={"items": ["q1", "q1", "fake", "x1"]}, headers=h).get_json()
        self.assertEqual((res["found"], res["total"], res["added"]), (["q1"], 2, 1))
        c.post(f"/api/quest/{SLUG}/found", json={"items": ["q2"]}, headers=h)
        lead = c.get(f"/api/quest/{SLUG}/leaders").get_json()
        self.assertEqual((lead["leaders"][0]["name"], lead["leaders"][0]["found"], lead["leaders"][0]["done"]), ("Охотник", 2, True))
        self.assertNotIn("email", lead["leaders"][0])

    def test_pano_upload_checks(self):
        c = self.c
        editor = self.login("editor@arena.local", "editor12345")

        def up(data, kind=None):
            form = {"file": (io.BytesIO(data), "p.png", "image/png")}
            if kind:
                form["kind"] = kind
            return c.post("/api/uploads", data=form, headers=editor, content_type="multipart/form-data")

        self.assertEqual(up(png_header(4096, 2048), "pano360").status_code, 201)
        self.assertEqual(up(png_header(3000, 2000), "pano360").status_code, 422)      # не 2:1
        self.assertEqual(up(png_header(1024, 512), "pano360").status_code, 422)       # слишком маленькая
        self.assertEqual(up(png_header(40000, 20000)).status_code, 415)               # больше 16384
        self.assertEqual(up(png_header(800, 600)).get_json()["width"], 800)
        # видео переходов: только настоящие MP4 / WebM
        def vid(data, mime, name):
            return c.post("/api/uploads", data={"file": (io.BytesIO(data), name, mime), "kind": "video"}, headers=editor, content_type="multipart/form-data")
        mp4 = vid(bytes.fromhex("00000018") + b"ftypmp42" + bytes(64), "video/mp4", "walk.mp4")
        self.assertEqual(mp4.status_code, 201)
        self.assertTrue(mp4.get_json()["url"].endswith(".mp4"))
        self.assertEqual(vid(bytes.fromhex("1a45dfa3") + bytes(64), "video/webm", "walk.webm").status_code, 201)
        self.assertEqual(vid(b"<html>not a video</html>", "video/mp4", "x.mp4").status_code, 415)
        self.assertEqual(vid(png_header(64, 48), "image/png", "x.png").status_code, 415)

if __name__ == "__main__":
    unittest.main()
