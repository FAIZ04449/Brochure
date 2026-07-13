import os
import time
import secrets
import threading
from datetime import datetime, timedelta
from functools import wraps
import urllib.request
import json

from flask import Flask, request, jsonify, make_response, send_file, session, redirect, url_for
from collections import defaultdict

import database

app = Flask(__name__, static_folder='static', static_url_path='/static')
app.secret_key = os.environ.get("SECRET_KEY", "super-secret-key-pdf-tracker-98234")

# Admin password setup (default 'admin' if env var not set)
ADMIN_PASSWORD = os.environ.get("ADMIN_PASSWORD", "admin")

# Create storage directory for uploaded PDFs
STORAGE_DIR = os.environ.get("STORAGE_DIR", os.path.join(os.path.dirname(os.path.abspath(__file__)), 'storage'))
os.makedirs(STORAGE_DIR, exist_ok=True)

# Initialize database tables on startup
database.init_db()

# --- Simple In-Memory Rate Limiter ---
rate_limit_store = defaultdict(list)
RATE_LIMIT_MAX = 60  # max requests
RATE_LIMIT_WINDOW = 60  # window in seconds

def rate_limit_check(ip):
    now = time.time()
    # Filter out timestamps older than window
    rate_limit_store[ip] = [t for t in rate_limit_store[ip] if now - t < RATE_LIMIT_WINDOW]
    if len(rate_limit_store[ip]) >= RATE_LIMIT_MAX:
        return False
    rate_limit_store[ip].append(now)
    return True

@app.before_request
def check_rate_limits():
    """Applies rate limits to API endpoints only (exempting static files and dashboard routes)."""
    if request.path.startswith('/api/sessions'):
        ip = request.headers.get('X-Forwarded-For', request.remote_addr)
        if ip and ',' in ip:
            ip = ip.split(',')[0].strip()
        if not rate_limit_check(ip):
            return jsonify({'error': 'Rate limit exceeded. Please wait a minute.'}), 429

# Enable CORS for developer ease (optional but good practice)
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

# --- Geolocation Resolution Helper ---
def get_ip_geo(ip):
    if not ip or ip in ('127.0.0.1', '::1') or ip.startswith('192.168.') or ip.startswith('10.'):
        return 'Local Network', 'Localhost'
    try:
        # Query ip-api.com
        url = f"http://ip-api.com/json/{ip}?fields=status,country,city"
        req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
        with urllib.request.urlopen(req, timeout=3) as resp:
            data = json.loads(resp.read().decode('utf-8'))
            if data.get('status') == 'success':
                return data.get('country', 'Unknown'), data.get('city', 'Unknown')
    except Exception as e:
        print(f"GeoIP resolution failed via ip-api for {ip}: {e}")
        try:
            # Fallback to ipapi.co
            url = f"https://ipapi.co/{ip}/json/"
            req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
            with urllib.request.urlopen(req, timeout=3) as resp:
                data = json.loads(resp.read().decode('utf-8'))
                return data.get('country_name', 'Unknown'), data.get('city', 'Unknown')
        except Exception as e2:
            print(f"GeoIP resolution failed via ipapi.co for {ip}: {e2}")
    return 'Unknown', 'Unknown'

# --- SLACK NOTIFICATIONS ON FIRST OPEN ---

def send_slack_notification_worker(webhook_url, payload):
    """Sends POST request to Slack Webhook URL with timeout and exactly 1 retry on network failure."""
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
            print(f"Attempt {attempt + 1} failed to send Slack notification: {e}")
            if attempt == 0:
                time.sleep(2)  # Delay 2 seconds before retrying
    print("Failed to send Slack notification after 2 attempts.")

def send_slack_notification_async(session_id, host_url):
    """Asynchronously triggers Slack open alert in a background thread."""
    webhook_url = os.environ.get("SLACK_WEBHOOK_URL")
    if not webhook_url:
        print("Slack notification bypassed: SLACK_WEBHOOK_URL env variable is not set.")
        return
        
    recipient_info = database.get_recipient_by_session_id(session_id)
    if not recipient_info:
        print(f"Slack notification bypassed: no recipient found for session {session_id}")
        return
        
    link_id = recipient_info['link_id']
    name = recipient_info['recipient_name']
    email = recipient_info['recipient_email']
    company = recipient_info['recipient_company']
    filename = recipient_info['filename']
    
    country = recipient_info.get('geo_country') or 'Unknown Country'
    city = recipient_info.get('geo_city') or 'Unknown City'
    location = f"{city}, {country}" if city != 'Unknown City' else country
    
    timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S Local Time")
    dashboard_link = f"{host_url}dashboard?link_id={link_id}"
    
    message_content = (
        f"Brochure '{filename}' opened by {name} ({email}) at {company}.\n"
        f"Location: {location}\n"
        f"Time spent on pages: Page 1: 0s (just opened)\n"
        f"URLs opened: None"
    )
    
    payload = {
        "message": message_content,
        "text": message_content,
        "name": name,
        "email": email,
        "company": company,
        "filename": filename,
        "brochure_name": filename,
        "location": location,
        "time_spent": "Page 1: 0s (just opened)",
        "urls_opened": "None",
        "blocks": [
            {
                "type": "section",
                "text": {
                    "type": "mrkdwn",
                    "text": f"*Brochure Opened* 📄\n*Document:* `{filename}`\n*Recipient:* {name} (<mailto:{email}|{email}>) at *{company}*\n*Location:* {location}\n*Opened at:* {timestamp}\n<{dashboard_link}|*View Journey Details in Dashboard*>"
                }
            }
        ]
    }
    
    threading.Thread(target=send_slack_notification_worker, args=(webhook_url, payload), daemon=True).start()

# --- PUBLIC ROUTING ---

def serve_static_html(filename):
    """Reads HTML files directly from static folder to bypass Gunicorn wsgi.file_wrapper bugs."""
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
    """Health check endpoint for Render/hosting platforms."""
    return jsonify({'status': 'healthy'}), 200

@app.route('/api/test-slack')
def api_test_slack():
    """Manual test endpoint to check Slack notification blocks format."""
    webhook_url = os.environ.get("SLACK_WEBHOOK_URL")
    if not webhook_url:
        return jsonify({'error': 'SLACK_WEBHOOK_URL environment variable is not configured'}), 400
        
    mock_link = {
        'link_id': 999,
        'recipient_name': 'Test Recipient',
        'recipient_email': 'test@example.com',
        'recipient_company': 'Acme Test Corp',
        'filename': 'Test_Brochure.pdf'
    }
    
    send_slack_notification_async(mock_link, request.host_url)
    return jsonify({'status': 'success', 'message': 'Test Slack notification triggered in background.'}), 200

@app.route('/')
def home():
    """Redirects base root to the admin dashboard."""
    return redirect(url_for('dashboard'))

@app.route('/v/<token>')
def resolve_token_link(token):
    """Resolves token to render HTML5 viewer if active, else shows Link Not Found."""
    link = database.get_link_by_token(token)
    if not link or database.is_link_invalid(link):
        return serve_static_html('not_found.html'), 404
    return serve_static_html('viewer.html')

@app.route('/v/<token>/pdf')
def serve_raw_pdf_bytes(token):
    """Streams original brochure bytes only if token is valid."""
    link = database.get_link_by_token(token)
    if not link or database.is_link_invalid(link):
        return jsonify({'error': 'Unauthorized or link invalid'}), 404
    
    file_path = link['storage_path']
    if not os.path.exists(file_path):
        return jsonify({'error': 'Brochure file missing from backend storage'}), 404
        
    return send_file(
        file_path, 
        mimetype='application/pdf', 
        download_name=link['filename']
    )

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
        
    # Get client details
    ip_address = request.headers.get('X-Forwarded-For', request.remote_addr)
    if ip_address and ',' in ip_address:
        ip_address = ip_address.split(',')[0].strip()
        
    user_agent = request.headers.get('User-Agent', 'Unknown')
    country, city = get_ip_geo(ip_address)
    
    # Check if this is the recipient's first open (0 previous sessions)
    is_first_open = (database.get_session_count_for_link(link['link_id']) == 0)

    session_id = secrets.token_hex(16)
    success = database.create_session(
        session_id=session_id,
        link_id=link['link_id'],
        ip_address=ip_address,
        user_agent=user_agent,
        country=country,
        city=city
    )
    
    if success:
        if is_first_open:
            send_slack_notification_async(session_id, request.host_url)
        return jsonify({'status': 'success', 'session_id': session_id}), 201
    return jsonify({'error': 'Session initialization failed'}), 500

@app.route('/api/sessions/<session_id>/heartbeat', methods=['POST', 'OPTIONS'])
def api_session_heartbeat(session_id):
    if request.method == 'OPTIONS':
        return make_response(jsonify({'status': 'ok'}), 200)
        
    success = database.update_session_heartbeat(session_id)
    if success:
        return jsonify({'status': 'success', 'message': 'Heartbeat logged'}), 200
    return jsonify({'error': 'Heartbeat update failed'}), 500

@app.route('/api/sessions/<session_id>/page-event', methods=['POST', 'OPTIONS'])
def api_page_event(session_id):
    if request.method == 'OPTIONS':
        return make_response(jsonify({'status': 'ok'}), 200)
        
    # Standard beacons can come via form URL-encoded payload or JSON
    data = None
    if request.is_json:
        data = request.json
    elif request.data:
        try:
            data = json.loads(request.data.decode('utf-8'))
        except Exception:
            pass
            
    if not data:
        # Check standard POST parameters (fallback)
        data = request.form
        
    page_number = data.get('page_number')
    active_seconds = data.get('active_seconds')
    
    if page_number is None or active_seconds is None:
        return jsonify({'error': 'Missing parameters'}), 400
        
    try:
        page_number = int(page_number)
        active_seconds = float(active_seconds)
    except ValueError:
        return jsonify({'error': 'Invalid parameter format'}), 400
        
    success = database.upsert_page_event(session_id, page_number, active_seconds)
    if success:
        return jsonify({'status': 'success'}), 200
    return jsonify({'error': 'Failed to save page duration'}), 500

@app.route('/api/sessions/<session_id>/click', methods=['POST', 'OPTIONS'])
def api_click_event(session_id):
    if request.method == 'OPTIONS':
        return make_response(jsonify({'status': 'ok'}), 200)
        
    data = None
    if request.is_json:
        data = request.json
    elif request.data:
        try:
            data = json.loads(request.data.decode('utf-8'))
        except Exception:
            pass
            
    if not data:
        data = request.form
        
    page_number = data.get('page_number')
    target_url = data.get('target_url')
    
    if page_number is None or target_url is None:
        return jsonify({'error': 'Missing parameters'}), 400
        
    try:
        page_number = int(page_number)
    except ValueError:
        return jsonify({'error': 'Invalid page number'}), 400
        
    success = database.log_click_event(session_id, page_number, target_url)
    if success:
        return jsonify({'status': 'success'}), 201
    return jsonify({'error': 'Failed to log click'}), 500

# --- ADMIN INTERFACE AND PORTAL ---

@app.route('/login', methods=['GET', 'POST'])
def login():
    """Handles admin session login authentication."""
    if request.method == 'POST':
        password = None
        if request.is_json:
            password = request.json.get('password')
        else:
            password = request.form.get('password')
            
        if password == ADMIN_PASSWORD:
            session['logged_in'] = True
            return jsonify({'status': 'success', 'message': 'Authenticated'}), 200
        return jsonify({'error': 'Invalid credentials'}), 401
        
    if session.get('logged_in'):
        return redirect(url_for('dashboard'))
    return serve_static_html('login.html')

@app.route('/logout')
def logout():
    session.pop('logged_in', None)
    return redirect(url_for('login'))

@app.route('/dashboard')
def dashboard():
    """Renders the dashboard UI if authorized, otherwise redirects to login."""
    if not session.get('logged_in'):
        return redirect(url_for('login'))
    return serve_static_html('dashboard.html')

# --- ADMIN API ENDPOINTS (Protected) ---

@app.route('/api/admin/analytics', methods=['GET'])
@admin_required
def api_admin_analytics():
    """Retrieves all dashboard summary figures, recipient link metrics, and file listing."""
    stats = database.get_dashboard_stats()
    logs = database.get_all_recipient_logs()
    docs = database.list_documents()
    global_page_stats = database.get_page_stats_all()
    global_click_stats = database.get_click_stats_all()
    
    return jsonify({
        'summary': stats,
        'logs': logs,
        'documents': docs,
        'global_page_stats': global_page_stats,
        'global_click_stats': global_click_stats
    }), 200

@app.route('/api/admin/recipient-details/<int:link_id>', methods=['GET'])
@admin_required
def api_admin_recipient_details(link_id):
    """Retrieves specific viewer sessions, page statistics and links clicked for a recipient."""
    details = database.get_recipient_session_details(link_id)
    return jsonify(details), 200

@app.route('/api/admin/timeline/<session_id>', methods=['GET'])
@admin_required
def api_admin_timeline(session_id):
    """Reconstructs the detailed chronological step journey of a recipient session."""
    timeline = database.get_session_timeline(session_id)
    return jsonify({'timeline': timeline}), 200

@app.route('/api/admin/upload', methods=['POST'])
@admin_required
def api_admin_upload():
    """Handles brochure PDF upload and registers it in database."""
    if 'file' not in request.files:
        return jsonify({'error': 'No file segment found'}), 400
        
    file = request.files['file']
    if file.filename == '':
        return jsonify({'error': 'No filename provided'}), 400
        
    if not file.filename.lower().endswith('.pdf'):
        return jsonify({'error': 'Only PDF formats are supported'}), 400
        
    # Keep file bytes original and save with timestamped prefix to avoid collision
    safe_filename = f"{int(time.time())}_{secure_filename_fallback(file.filename)}"
    storage_path = os.path.join(STORAGE_DIR, safe_filename)
    
    try:
        file.save(storage_path)
        doc_id = database.add_document(file.filename, storage_path)
        if doc_id:
            return jsonify({'status': 'success', 'document_id': doc_id, 'filename': file.filename}), 201
        return jsonify({'error': 'Failed to save document metadata'}), 500
    except Exception as e:
        return jsonify({'error': f"Error saving file: {str(e)}"}), 500

@app.route('/api/admin/generate-link', methods=['POST'])
@admin_required
def api_admin_generate_link():
    """Creates a tracking link for a single recipient."""
    data = request.json or {}
    document_id = data.get('document_id')
    name = data.get('name', '').strip()
    email = data.get('email', '').strip()
    company = data.get('company', '').strip()
    expires_days = data.get('expires_days')
    
    if not document_id or not name or not email or not company:
        return jsonify({'error': 'All fields are required'}), 400
        
    # Resolve expiry datetime
    expires_at = None
    if expires_days:
        try:
            expires_at = (datetime.utcnow() + timedelta(days=int(expires_days))).isoformat()
        except ValueError:
            pass
            
    # Add recipient
    recipient_id = database.add_recipient(name, email, company)
    if not recipient_id:
        return jsonify({'error': 'Failed to create or fetch recipient'}), 500
        
    # Generate token
    token = secrets.token_urlsafe(16)
    
    link_id = database.create_link(token, document_id, recipient_id, expires_at)
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
    """Accepts CSV layout and generates bulk tracking links in JSON and copyable CSV formats."""
    data = request.json or {}
    document_id = data.get('document_id')
    csv_text = data.get('csv_text', '').strip()
    expires_days = data.get('expires_days')
    
    if not document_id or not csv_text:
        return jsonify({'error': 'Document ID and CSV content required'}), 400
        
    # Resolve expiry
    expires_at = None
    if expires_days:
        try:
            expires_at = (datetime.utcnow() + timedelta(days=int(expires_days))).isoformat()
        except ValueError:
            pass
            
    lines = csv_text.split('\n')
    results = []
    csv_output_lines = ["Name,Email,Company,TrackableLink"]
    
    # Process lines
    for line in lines:
        if not line.strip():
            continue
        parts = [p.strip() for p in line.split(',')]
        if len(parts) < 3:
            continue # Skip invalid lines
            
        # Handle optional header detection
        if parts[0].lower() == 'name' and parts[1].lower() == 'email':
            continue
            
        name, email, company = parts[0], parts[1], parts[2]
        
        recipient_id = database.add_recipient(name, email, company)
        if not recipient_id:
            continue
            
        token = secrets.token_urlsafe(16)
        link_id = database.create_link(token, document_id, recipient_id, expires_at)
        
        if link_id:
            unique_link = f"{request.host_url}v/{token}"
            results.append({
                'name': name,
                'email': email,
                'company': company,
                'url': unique_link
            })
            csv_output_lines.append(f'"{name}","{email}","{company}","{unique_link}"')
            
    return jsonify({
        'status': 'success',
        'count': len(results),
        'results': results,
        'csv_output': '\n'.join(csv_output_lines)
    }), 200

@app.route('/api/admin/revoke-link', methods=['POST'])
@admin_required
def api_admin_revoke_link():
    data = request.json or {}
    token = data.get('token')
    if not token:
        return jsonify({'error': 'Token required'}), 400
        
    success = database.revoke_link(token)
    if success:
        return jsonify({'status': 'success', 'message': 'Link revoked successfully'}), 200
    return jsonify({'error': 'Failed to revoke link'}), 500

# --- UTILS ---
def secure_filename_fallback(filename):
    """Strips path characters to keep uploads inside storage directory."""
    return ''.join(c for c in filename if c.isalnum() or c in ('.', '_', '-'))

if __name__ == '__main__':
    print("Starting server on port 5000...")
    print(f"Default admin password is set to: '{ADMIN_PASSWORD}'")
    app.run(host='0.0.0.0', port=5000, debug=True)
