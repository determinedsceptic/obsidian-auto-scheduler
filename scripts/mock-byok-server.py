"""Local, keyless BYOK UI fixture. Does not contact a model provider."""
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

TASKS = [dict(title=f"BYOK测试：课程{i}复习", minutes=120, priority=4, split=True,
              minMinutes=30, due=None, earliest=None) for i in (1, 2)]

class Handler(BaseHTTPRequestHandler):
    def reply(self, status, data):
        payload = json.dumps(data, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self):
        if self.path == '/v1/models':
            self.reply(200, {'data': [{'id': 'auto-scheduler-ui-fixture'}]})
        else:
            self.reply(404, {})

    def do_POST(self):
        length = int(self.headers.get('Content-Length', '0'))
        if length > 100000:
            self.reply(413, {})
            return
        try:
            data = json.loads(self.rfile.read(length))
        except (ValueError, UnicodeDecodeError):
            self.reply(400, {})
            return
        if self.path != '/v1/chat/completions' or data.get('model') != 'auto-scheduler-ui-fixture':
            self.reply(400, {})
            return
        self.reply(200, {'choices': [{'finish_reason': 'tool_calls', 'message': {
            'role': 'assistant', 'content': None, 'tool_calls': [{
                'id': 'fixture-call', 'type': 'function', 'function': {
                    'name': 'create_tasks', 'arguments': json.dumps({'tasks': TASKS}, ensure_ascii=False)
                }}]
        }}]})

if __name__ == '__main__':
    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    print(f'Local mock API: http://127.0.0.1:{server.server_port}/v1', flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
