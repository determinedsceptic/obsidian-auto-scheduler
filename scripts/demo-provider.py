"""Deterministic localhost fixture for native screenshots. No upstream API calls."""
import argparse
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

MODEL = 'local-demo-fixture'

class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass  # Never log chat messages or Authorization headers.

    def reply(self, status, data):
        payload = json.dumps(data).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self):
        self.reply(200, {'data': [{'id': MODEL}]}) if self.path == '/v1/models' else self.reply(404, {})

    def do_POST(self):
        size = int(self.headers.get('Content-Length', '0'))
        if size > 100000:
            self.reply(413, {})
            return
        try:
            data = json.loads(self.rfile.read(size))
        except (ValueError, UnicodeDecodeError):
            self.reply(400, {})
            return
        if self.path != '/v1/chat/completions' or data.get('model') != MODEL:
            self.reply(400, {})
            return
        prompt = next((m['content'] for m in reversed(data.get('messages', [])) if m.get('role') == 'user'), '').lower()
        if 'walk' in prompt or 'habit' in prompt:
            name = 'create_habits'
            arguments = {'habits': [{'title': 'Evening walk', 'start': '19:00', 'end': '19:30', 'days': list(range(7)), 'priority': 3}]}
        else:
            name = 'create_tasks'
            arguments = {'tasks': [dict(title=f'Review {course}', minutes=120, priority=4, split=True,
                                        minMinutes=30, due=None, earliest=None) for course in ['Linear Algebra', 'Statistics']]}
        self.reply(200, {'choices': [{'finish_reason': 'tool_calls', 'message': {'role': 'assistant', 'content': None,
            'tool_calls': [{'id': 'demo-call', 'type': 'function', 'function': {'name': name, 'arguments': json.dumps(arguments)}}]}}]})

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port', type=int, default=0)
    args = parser.parse_args()
    server = ThreadingHTTPServer(('127.0.0.1', args.port), Handler)
    print(f'Local demo API: http://127.0.0.1:{server.server_port}/v1; model: {MODEL}', flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
