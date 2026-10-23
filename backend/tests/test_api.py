"""Запуск: python -m unittest discover -s tests  (из папки backend)."""
import io
import tempfile
import unittest
from pathlib import Path

from app import create_app

SLUG = "rostov-arena"


class ApiTest(unittest.TestCase):
    def setUp(self):
        tmp = Path(tempfile.mkdtemp())
        self.app = create_app({"DB_PATH": str(tmp / "t.db"), "UPLOAD_DIR": str(tmp / "up"), "SECRET_KEY": "test"})
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
        r = c.post("/api/users", json={"email": "new@arena.local", "password": "secret1", "role": "viewer"}, headers=admin)
        self.assertEqual(r.status_code, 201)
        uid = r.get_json()["id"]
        self.assertEqual(c.post("/api/users", json={"email": "new@arena.local", "password": "secret1"}, headers=admin).status_code, 409)
        self.assertEqual(c.patch(f"/api/users/{uid}", json={"role": "editor"}, headers=admin).get_json()["role"], "editor")
        new = self.login("new@arena.local", "secret1")
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
        png = b"\x89PNG\r\n\x1a\n" + b"0" * 32
        r = c.post("/api/uploads", data={"file": (io.BytesIO(png), "a.png", "image/png")}, headers=editor, content_type="multipart/form-data")
        self.assertEqual(r.status_code, 201)
        self.assertEqual(c.get(r.get_json()["url"]).status_code, 200)
        fake = c.post("/api/uploads", data={"file": (io.BytesIO(b"<html>"), "a.png", "image/png")}, headers=editor, content_type="multipart/form-data")
        self.assertEqual(fake.status_code, 415)
        self.assertEqual(c.post("/api/uploads", data={"file": (io.BytesIO(png), "a.png", "image/png")}, headers=viewer, content_type="multipart/form-data").status_code, 403)
        self.assertEqual(c.get("/").status_code, 200)
        self.assertEqual(c.get("/admin").status_code, 200)
        self.assertEqual(c.get("/api/nothing").status_code, 404)


if __name__ == "__main__":
    unittest.main()
