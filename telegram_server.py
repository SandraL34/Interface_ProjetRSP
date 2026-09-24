import json
import os
import ssl
from http.server import BaseHTTPRequestHandler, HTTPServer
from socketserver import ThreadingMixIn
from urllib.parse import urlencode
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError

HOST = "127.0.0.1"
PORT = 8001


class ThreadingHTTPServer(ThreadingMixIn, HTTPServer):
    daemon_threads = True


class TelegramHandler(BaseHTTPRequestHandler):
    def _send_json(self, status, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self._send_json(204, {})

    def do_GET(self):
        if self.path == "/health":
            self._send_json(200, {"ok": True, "service": "telegram"})
            return
        self._send_json(404, {"error": "Route inconnue"})

    def do_POST(self):
        if self.path != "/api/alerts/telegram":
            self._send_json(404, {"error": "Route inconnue"})
            return

        token = os.environ.get("TELEGRAM_BOT_TOKEN", "").strip()
        if not token:
            self._send_json(500, {"error": "TELEGRAM_BOT_TOKEN n'est pas configure"})
            return

        try:
            length = int(self.headers.get("Content-Length", "0"))
            raw_body = self.rfile.read(length) or b"{}"
            if not isinstance(raw_body, str):
                raw_body = raw_body.decode("utf-8")
            data = json.loads(raw_body)
            chat_id = str(data.get("chatId", "")).strip()
            message = str(data.get("message", "")).strip()
            if not chat_id or not message:
                self._send_json(400, {"error": "chatId et message sont requis"})
                return

            body = urlencode({"chat_id": chat_id, "text": message}).encode("utf-8")
            request = Request(
                "https://api.telegram.org/bot{}/sendMessage".format(token),
                data=body,
                method="POST",
                headers={"Content-Type": "application/x-www-form-urlencoded"},
            )
            ssl_context = ssl._create_unverified_context()
            with urlopen(request, timeout=10, context=ssl_context) as response:
                telegram_result = json.loads(response.read().decode("utf-8"))

            if not telegram_result.get("ok"):
                self._send_json(502, {"error": "Telegram a refuse le message", "telegram": telegram_result})
                return
            self._send_json(200, {"ok": True})
        except ValueError:
            self._send_json(400, {"error": "JSON invalide"})
        except HTTPError as error:
            detail = error.read().decode("utf-8", errors="replace")
            try:
                telegram_error = json.loads(detail)
                message = telegram_error.get("description", detail)
            except ValueError:
                message = detail
            self._send_json(502, {"error": message, "detail": detail})
        except (URLError, TimeoutError) as error:
            self._send_json(502, {"error": "Telegram est inaccessible", "detail": str(error)})
        except Exception as error:
            self._send_json(500, {"error": "Erreur serveur", "detail": str(error)})

    def log_message(self, format_string, *args):
        print("[{}] {}".format(self.log_date_time_string(), format_string % args))


if __name__ == "__main__":
    if not os.environ.get("TELEGRAM_BOT_TOKEN"):
        print("Erreur : definissez TELEGRAM_BOT_TOKEN avant de lancer le serveur.")
        print('$env:TELEGRAM_BOT_TOKEN = "votre_token"')
        raise SystemExit(1)
    server = ThreadingHTTPServer((HOST, PORT), TelegramHandler)
    print("Serveur Telegram actif sur http://{}:{}".format(HOST, PORT))
    server.serve_forever()
