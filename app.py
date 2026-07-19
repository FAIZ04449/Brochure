import os
import time
import secrets
import threading
from datetime import datetime, timedelta
from functools import wraps
import urllib.request
import json
from werkzeug.utils import secure_filename

from flask import Flask, request, jsonify, make_response, send_file, session, redirect, url_for
from collections import defaultdict

import database

app = Flask(__name__, static_folder='static', static_url_path='/static')
app.secret_key = os.environ.get("SECRET_KEY", "super-secret-key-pdf-tracker-98234")

# Admin password setup (default 'admin' if env var not set)
ADMIN_PASSWORD = os.environ.get("ADMIN_PASSWORD", "admin")

# Create storage directory for uploaded files
STORAGE_DIR = os.environ.get("STORAGE_DIR", os.path.join(os.path.dirname(os.path.abspath(__file__)), 'storage'))
os.makedirs(STORAGE_DIR, exist_ok=True)

# Initialize database tables on startup
database.init_db()

# Enable WAL mode for faster concurrent reads
import sqlite3 as _sqlite3
try:
    _conn = _sqlite3.connect(database.DATABASE_FILE)
    _conn.execute("PRAGMA journal_mode=WAL;")
    _conn.execute("PRAGMA synchronous=NORMAL;")
    _conn.execute("PRAGMA cache_size=-32000;")  # 32MB cache
    _conn.close()
    print("SQLite WAL mode enabled.")
except Exception as _e:
    print(f"WAL mode setup warning: {_e}")

# --- Simple In-Memory Rate Limiter ---
rate_limit_store = defaultdict(list)
RATE_LIMIT_MAX = 60  # max requests
RATE_LIMIT_WINDOW = 60  # window in seconds

def rate_limit_check(ip):
    now = time.time()
    rate_limit_store[ip] = [t for t in rate_limit_store[ip] if now - t < RATE_LIMIT_WINDOW]
    if len(rate_limit_store[ip]) >= RATE_LIMIT_MAX:
        return False
    rate_limit_store[ip].append(now)
    return True

@app.before_request
def check_rate_limits():
    """Applies rate limits to API endpoints only."""
    if request.path.startswith('/api/sessions'):
        ip = request.headers.get('X-Forwarded-For', request.remote_addr)
        if ip and ',' in ip:
            ip = ip.split(',')[0].strip()
        if not rate_limit_check(ip):
            return jsonify({'error': 'Rate limit exceeded. Please wait a minute.'}), 429

@app.after_request
def add_cors_headers(response):
    response.headers.add('Access-Control-Allow-Origin', '*')
    response.headers.add('Access-Control-Allow-Headers', 'Content-Type,Authorization')
    response.headers.add('Access-Control-Allow-Methods', 'GET,PUT,POST,DELETE,OPTIONS')
    return response

# --- Auth Decorator ---
def admin_required(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        if not session.get('logged_in'):
            return jsonify({'error': 'Unauthorized access'}), 401
        return f(*args, **kwargs)
    return decorated

# --- Geolocation Resolution Helper (non-blocking) ---
_geo_cache = {}  # simple in-memory cache

def get_ip_geo(ip):
    """Sync geo lookup — only called in background thread."""
    if not ip or ip in ('127.0.0.1', '::1') or ip.startswith('192.168.') or ip.startswith('10.'):
        return 'Local Network', 'Localhost'
    if ip in _geo_cache:
        return _geo_cache[ip]
    try:
        url = f"http://ip-api.com/json/{ip}?fields=status,country,city"
        req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
        with urllib.request.urlopen(req, timeout=3) as resp:
            data = json.loads(resp.read().decode('utf-8'))
            if data.get('status') == 'success':
                result = data.get('country', 'Unknown'), data.get('city', 'Unknown')
                _geo_cache[ip] = result
                return result
    except Exception as e:
        print(f"GeoIP resolution failed for {ip}: {e}")
    result = 'Unknown', 'Unknown'
    _geo_cache[ip] = result
    return result

def _resolve_geo_and_notify(session_id, ip_address, host_url, is_first_open):
    """Background worker: resolve geo, update session, send Slack."""
    country, city = get_ip_geo(ip_address)
    try:
        conn = _sqlite3.connect(database.DATABASE_FILE)
        conn.execute(
            "UPDATE sessions SET geo_country=?, geo_city=? WHERE id=?",
            (country, city, session_id)
        )
        conn.commit()
        conn.close()
    except Exception as e:
        print(f"Geo update failed for {session_id}: {e}")
    if is_first_open:
        send_slack_notification_async(session_id, host_url)

# --- SLACK NOTIFICATIONS ON FIRST OPEN ---

def send_slack_notification_worker(webhook_url, payload):
    data = json.dumps(payload).encode('utf-8')
    headers = {'Content-Type': 'application/json'}
    req = urllib.request.Request(webhook_url, data=data, headers=headers)
    for attempt in range(2):
        try:
            with urllib.request.urlopen(req, timeout=5) as resp:
                if resp.status in (200, 204):
                    print("Slack notification sent successfully.")
                    return
                else:
                    print(f"Slack webhook returned non-200 status: {resp.status}")
        except Exception as e:
            if attempt == 0: time.sleep(2)
    print("Failed to send Slack notification after 2 attempts.")

def send_slack_notification_async(session_id, host_url):
    webhook_url = os.environ.get("SLACK_WEBHOOK_URL")
    if not webhook_url: return
        
    recipient_info = database.get_recipient_by_session_id(session_id)
    if not recipient_info: return
        
    link_id = recipient_info['link_id']
    name = recipient_info['recipient_name']
    email = recipient_info['recipient_email']
    company = recipient_info['recipient_company']
    filename = recipient_info.get('filename', 'Unknown Document Bundle')
    
    country = recipient_info.get('geo_country') or 'Unknown Country'
    city = recipient_info.get('geo_city') or 'Unknown City'
    location = f"{city}, {country}" if city != 'Unknown City' else country
    
    timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S Local Time")
    dashboard_link = f"{host_url}dashboard?link_id={link_id}"
    
    message_content = (
        f"Bundle '{filename}' opened by {name} ({email}) at {company}.\n"
        f"Location: {location}\n"
    )
    
    payload = {
        "text": message_content,
        "blocks": [
            {
                "type": "section",
                "text": {
                    "type": "mrkdwn",
                    "text": f"*Link Opened* 🚀\n*Bundle:* `{filename}`\n*Recipient:* {name} (<mailto:{email}|{email}>) at *{company}*\n*Location:* {location}\n*Opened at:* {timestamp}\n<{dashboard_link}|*View Journey Details in Dashboard*>"
                }
            }
        ]
    }
    threading.Thread(target=send_slack_notification_worker, args=(webhook_url, payload), daemon=True).start()

# --- PUBLIC ROUTING ---

def serve_static_html(filename):
    file_path = os.path.join(app.static_folder, filename)
    try:
        with open(file_path, 'r', encoding='utf-8') as f:
            content = f.read()
        response = make_response(content)
        response.headers['Content-Type'] = 'text/html; charset=utf-8'
        return response
    except Exception as e:
        print(f"Error serving {filename}: {e}")
        return "File Not Found", 404

@app.route('/healthz')
def healthz():
    return jsonify({'status': 'healthy'}), 200

@app.route('/')
def home():
    return redirect(url_for('dashboard'))

@app.route('/v/<token>')
def resolve_token_link(token):
    link = database.get_link_by_token(token)
    if not link or database.is_link_invalid(link):
        return serve_static_html('not_found.html'), 404
    return serve_static_html('viewer.html')

@app.route('/v/<token>/file/<int:doc_id>')
def serve_raw_file_bytes(token, doc_id):
    """Streams original file bytes only if token is valid and doc belongs to link."""
    link = database.get_link_by_token(token)
    if not link or database.is_link_invalid(link):
        return jsonify({'error': 'Unauthorized or link invalid'}), 404
    
    # Check if doc_id is part of this link
    target_doc = next((d for d in link.get('documents', []) if d['id'] == doc_id), None)
    if not target_doc:
        return jsonify({'error': 'Document not authorized for this link'}), 403

    if target_doc['doc_type'] == 'link':
        return jsonify({'error': 'External link documents have no internal file to stream'}), 400

    file_path = target_doc['storage_path']
    if not os.path.exists(file_path):
        return jsonify({'error': 'File missing from backend storage'}), 404
        
    mimetype = 'application/pdf'
    if target_doc['doc_type'] == 'video':
        mimetype = 'video/mp4'

    return send_file(
        file_path, 
        mimetype=mimetype, 
        download_name=target_doc['filename']
    )

# Legacy fallback for older frontend logic
@app.route('/v/<token>/pdf')
def serve_legacy_pdf(token):
    link = database.get_link_by_token(token)
    if not link or database.is_link_invalid(link):
        return jsonify({'error': 'Unauthorized'}), 404
    
    if link.get('documents') and len(link['documents']) > 0:
        first_doc = link['documents'][0]
        if first_doc['doc_type'] != 'link' and os.path.exists(first_doc['storage_path']):
            return send_file(first_doc['storage_path'], mimetype='application/pdf', download_name=first_doc['filename'])
    
    return jsonify({'error': 'No file available'}), 404

# --- RECIPIENT TRACKING ENDPOINTS ---

@app.route('/api/sessions', methods=['POST', 'OPTIONS'])
def api_session_start():
    if request.method == 'OPTIONS':
        return make_response(jsonify({'status': 'ok'}), 200)
        
    data = request.json or {}
    token = data.get('token')
    if not token:
        return jsonify({'error': 'Token required'}), 400
        
    link = database.get_link_by_token(token)
    if not link or database.is_link_invalid(link):
        return jsonify({'error': 'Invalid or expired token'}), 404
        
    ip_address = request.headers.get('X-Forwarded-For', request.remote_addr)
    if ip_address and ',' in ip_address:
        ip_address = ip_address.split(',')[0].strip()
        
    user_agent = request.headers.get('User-Agent', 'Unknown')
    is_first_open = (database.get_session_count_for_link(link['link_id']) == 0)

    # Create session immediately with placeholder geo — fill in async
    session_id = secrets.token_hex(16)
    success = database.create_session(
        session_id=session_id,
        link_id=link['link_id'],
        ip_address=ip_address,
        user_agent=user_agent,
        country='Resolving…',
        city='Resolving…'
    )
    
    if success:
        # Geo lookup + Slack in background — does NOT block response
        threading.Thread(
            target=_resolve_geo_and_notify,
            args=(session_id, ip_address, request.host_url, is_first_open),
            daemon=True
        ).start()
        return jsonify({
            'status': 'success', 
            'session_id': session_id,
            'documents': link.get('documents', [])
        }), 201
    return jsonify({'error': 'Session initialization failed'}), 500

@app.route('/api/sessions/<session_id>/heartbeat', methods=['POST', 'OPTIONS'])
def api_session_heartbeat(session_id):
    if request.method == 'OPTIONS': return make_response(jsonify({'status': 'ok'}), 200)
    success = database.update_session_heartbeat(session_id)
    if success: return jsonify({'status': 'success', 'message': 'Heartbeat logged'}), 200
    return jsonify({'error': 'Heartbeat update failed'}), 500

def _extract_data(req):
    if req.is_json: return req.json
    elif req.data:
        try: return json.loads(req.data.decode('utf-8'))
        except: pass
    return req.form

@app.route('/api/sessions/<session_id>/page-event', methods=['POST', 'OPTIONS'])
def api_page_event(session_id):
    if request.method == 'OPTIONS': return make_response(jsonify({'status': 'ok'}), 200)
    data = _extract_data(request) or {}
        
    document_id = data.get('document_id')
    page_number = data.get('page_number')
    active_seconds = data.get('active_seconds')
    
    if page_number is None or active_seconds is None or document_id is None:
        return jsonify({'error': 'Missing parameters'}), 400
        
    try:
        page_number = int(page_number)
        active_seconds = float(active_seconds)
        document_id = int(document_id)
    except ValueError:
        return jsonify({'error': 'Invalid parameter format'}), 400
        
    success = database.upsert_page_event(session_id, document_id, page_number, active_seconds)
    if success: return jsonify({'status': 'success'}), 200
    return jsonify({'error': 'Failed to save page duration'}), 500

@app.route('/api/sessions/<session_id>/component-event', methods=['POST', 'OPTIONS'])
def api_component_event(session_id):
    if request.method == 'OPTIONS': return make_response(jsonify({'status': 'ok'}), 200)
    data = _extract_data(request) or {}
    
    document_id = data.get('document_id')
    event_type = data.get('event_type')
    active_seconds = data.get('active_seconds', 0)
    event_data = data.get('event_data', '')
    
    if not document_id or not event_type:
        return jsonify({'error': 'Missing document_id or event_type'}), 400
        
    try:
        document_id = int(document_id)
        active_seconds = float(active_seconds)
    except ValueError:
        return jsonify({'error': 'Invalid parameter format'}), 400
        
    success = database.log_component_event(session_id, document_id, event_type, active_seconds, event_data)
    if success: return jsonify({'status': 'success'}), 200
    return jsonify({'error': 'Failed to log component event'}), 500

@app.route('/api/sessions/<session_id>/click', methods=['POST', 'OPTIONS'])
def api_click_event(session_id):
    if request.method == 'OPTIONS': return make_response(jsonify({'status': 'ok'}), 200)
    data = _extract_data(request) or {}
        
    document_id = data.get('document_id')
    page_number = data.get('page_number', 0) # 0 for non-pdf clicks
    target_url = data.get('target_url')
    
    if target_url is None or document_id is None:
        return jsonify({'error': 'Missing parameters'}), 400
        
    try:
        page_number = int(page_number)
        document_id = int(document_id)
    except ValueError:
        return jsonify({'error': 'Invalid format'}), 400
        
    success = database.log_click_event(session_id, document_id, page_number, target_url)
    if success: return jsonify({'status': 'success'}), 201
    return jsonify({'error': 'Failed to log click'}), 500

# --- ADMIN INTERFACE AND PORTAL ---

@app.route('/login', methods=['GET', 'POST'])
def login():
    if request.method == 'POST':
        password = request.json.get('password') if request.is_json else request.form.get('password')
        if password == ADMIN_PASSWORD:
            session['logged_in'] = True
            return jsonify({'status': 'success', 'message': 'Authenticated'}), 200
        return jsonify({'error': 'Invalid credentials'}), 401
    if session.get('logged_in'): return redirect(url_for('dashboard'))
    return serve_static_html('login.html')

@app.route('/logout')
def logout():
    session.pop('logged_in', None)
    return redirect(url_for('login'))

@app.route('/dashboard')
def dashboard():
    if not session.get('logged_in'): return redirect(url_for('login'))
    return serve_static_html('dashboard.html')

# --- ADMIN API ENDPOINTS (Protected) ---

@app.route('/api/admin/analytics', methods=['GET'])
@admin_required
def api_admin_analytics():
    """Fast endpoint: returns KPIs, documents, and campaign logs only."""
    stats = database.get_dashboard_stats()
    logs = database.get_all_recipient_logs()
    docs = database.list_documents()
    
    return jsonify({
        'summary': stats,
        'logs': logs,
        'documents': docs,
    }), 200

@app.route('/api/admin/analytics/charts', methods=['GET'])
@admin_required
def api_admin_analytics_charts():
    """Separate endpoint for heavier chart data — loaded after main data."""
    global_page_stats = database.get_page_stats_all()
    global_click_stats = database.get_click_stats_all()
    return jsonify({
        'global_page_stats': global_page_stats,
        'global_click_stats': global_click_stats,
    }), 200

@app.route('/api/admin/recipient-details/<int:link_id>', methods=['GET'])
@admin_required
def api_admin_recipient_details(link_id):
    details = database.get_recipient_session_details(link_id)
    return jsonify(details), 200

@app.route('/api/admin/timeline/<session_id>', methods=['GET'])
@admin_required
def api_admin_timeline(session_id):
    timeline = database.get_session_timeline(session_id)
    return jsonify({'timeline': timeline}), 200

@app.route('/api/admin/upload', methods=['POST'])
@admin_required
def api_admin_upload():
    """Handles file uploads (PDF or MP4)."""
    if 'file' not in request.files:
        return jsonify({'error': 'No file segment found'}), 400
        
    file = request.files['file']
    if file.filename == '':
        return jsonify({'error': 'No filename provided'}), 400
        
    doc_type = 'pdf'
    if file.filename.lower().endswith('.mp4'):
        doc_type = 'video'
    elif not file.filename.lower().endswith('.pdf'):
        return jsonify({'error': 'Only PDF or MP4 formats are supported for upload.'}), 400
        
    safe_filename = f"{int(time.time())}_{secure_filename_fallback(file.filename)}"
    storage_path = os.path.join(STORAGE_DIR, safe_filename)
    
    try:
        file.save(storage_path)
        doc_id = database.add_document(file.filename, storage_path, doc_type=doc_type)
        if doc_id:
            return jsonify({'status': 'success', 'document_id': doc_id, 'filename': file.filename, 'doc_type': doc_type}), 201
        return jsonify({'error': 'Failed to save document metadata'}), 500
    except Exception as e:
        return jsonify({'error': f"Error saving file: {str(e)}"}), 500

@app.route('/api/admin/add-link-doc', methods=['POST'])
@admin_required
def api_admin_add_link_doc():
    """Adds an external link (like a whiteboard URL or Youtube video) as a document."""
    data = request.json or {}
    name = data.get('name', '').strip()
    url = data.get('url', '').strip()
    
    if not name or not url:
        return jsonify({'error': 'Name and URL are required'}), 400
        
    try:
        metadata = json.dumps({'url': url})
        doc_id = database.add_document(name, "external_link", doc_type='link', metadata=metadata)
        if doc_id:
            return jsonify({'status': 'success', 'document_id': doc_id, 'filename': name, 'doc_type': 'link'}), 201
        return jsonify({'error': 'Failed to add link document'}), 500
    except Exception as e:
        return jsonify({'error': f"Error adding link: {str(e)}"}), 500

@app.route('/api/admin/generate-link', methods=['POST'])
@admin_required
def api_admin_generate_link():
    data = request.json or {}
    # Accept multiple document ids, fallback to single document_id for backwards compat
    document_ids = data.get('document_ids', [])
    if not document_ids and data.get('document_id'):
        document_ids = [data.get('document_id')]
        
    name = data.get('name', '').strip()
    email = data.get('email', '').strip()
    company = data.get('company', '').strip()
    expires_days = data.get('expires_days')
    
    if not document_ids or not name or not email or not company:
        return jsonify({'error': 'All fields are required (at least one document)'}), 400
        
    expires_at = None
    if expires_days:
        try:
            expires_at = (datetime.utcnow() + timedelta(days=int(expires_days))).isoformat()
        except ValueError:
            pass
            
    recipient_id = database.add_recipient(name, email, company)
    if not recipient_id:
        return jsonify({'error': 'Failed to create or fetch recipient'}), 500
        
    token = secrets.token_urlsafe(16)
    
    link_id = database.create_link(token, document_ids, recipient_id, expires_at)
    if link_id:
        unique_link = f"{request.host_url}v/{token}"
        return jsonify({
            'status': 'success',
            'token': token,
            'link_id': link_id,
            'url': unique_link
        }), 201
    return jsonify({'error': 'Failed to register tracking link'}), 500

@app.route('/api/admin/bulk-generate', methods=['POST'])
@admin_required
def api_admin_bulk_generate():
    data = request.json or {}
    document_ids = data.get('document_ids', [])
    if not document_ids and data.get('document_id'):
        document_ids = [data.get('document_id')]
        
    csv_text = data.get('csv_text', '').strip()
    expires_days = data.get('expires_days')
    
    if not document_ids or not csv_text:
        return jsonify({'error': 'Document IDs and CSV content required'}), 400
        
    expires_at = None
    if expires_days:
        try: expires_at = (datetime.utcnow() + timedelta(days=int(expires_days))).isoformat()
        except ValueError: pass
            
    lines = csv_text.split('\n')
    results = []
    csv_output_lines = ["Name,Email,Company,TrackableLink"]
    
    for line in lines:
        if not line.strip(): continue
        parts = [p.strip() for p in line.split(',')]
        if len(parts) < 3: continue
        if parts[0].lower() == 'name' and parts[1].lower() == 'email': continue
            
        name, email, company = parts[0], parts[1], parts[2]
        
        recipient_id = database.add_recipient(name, email, company)
        if not recipient_id: continue
            
        token = secrets.token_urlsafe(16)
        link_id = database.create_link(token, document_ids, recipient_id, expires_at)
        
        if link_id:
            unique_link = f"{request.host_url}v/{token}"
            results.append({
                'name': name, 'email': email, 'company': company, 'url': unique_link
            })
            csv_output_lines.append(f'"{name}","{email}","{company}","{unique_link}"')
            
    return jsonify({
        'status': 'success',
        'count': len(results),
        'results': results,
        'csv_output': '\n'.join(csv_output_lines)
    }), 200

@app.route('/api/admin/document/<int:doc_id>', methods=['DELETE'])
@admin_required
def api_admin_delete_document(doc_id):
    """Permanently deletes a stored document and its physical file."""
    success, msg = database.delete_document(doc_id)
    if success:
        return jsonify({'status': 'success', 'message': msg}), 200
    return jsonify({'error': msg}), 404 if msg == 'Document not found' else 500

@app.route('/api/admin/revoke-link', methods=['POST'])
@admin_required
def api_admin_revoke_link():
    data = request.json or {}
    token = data.get('token')
    if not token:
        return jsonify({'error': 'Token required'}), 400
        
    success = database.revoke_link(token)
    if success: return jsonify({'status': 'success', 'message': 'Link revoked successfully'}), 200
    return jsonify({'error': 'Failed to revoke link'}), 500

def secure_filename_fallback(filename):
    return ''.join(c for c in filename if c.isalnum() or c in ('.', '_', '-'))

if __name__ == '__main__':
    print("Starting server on port 5000...")
    print(f"Default admin password is set to: '{ADMIN_PASSWORD}'")
    app.run(host='0.0.0.0', port=5000, debug=True)
