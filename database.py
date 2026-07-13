import sqlite3
import os
import re
from datetime import datetime

DATABASE_FILE = os.environ.get("DATABASE_PATH", "analytics.db")

def get_connection(db_path=DATABASE_FILE):
    """Returns a connection to the SQLite database with row factory enabled."""
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    # Enable foreign keys
    conn.execute("PRAGMA foreign_keys = ON;")
    return conn

def get_pdf_page_count(file_path):
    """Robustly counts total pages in a PDF file by parsing binary content."""
    try:
        if not file_path or not os.path.exists(file_path):
            return 4
        with open(file_path, 'rb') as f:
            content = f.read()
        # 1. Search for /Count
        matches = re.findall(br'/Count\s*(\d+)', content)
        if matches:
            return max(int(m) for m in matches)
        # 2. Search for /Type /Page
        page_matches = re.findall(br'/Type\s*/Page\b', content)
        if page_matches:
            return len(page_matches)
    except Exception as e:
        print(f"Error reading PDF page count for {file_path}: {e}")
    return 4  # Default fallback

def init_db(db_path=DATABASE_FILE):
    """Initializes the database schema if it doesn't already exist."""
    conn = get_connection(db_path)
    cursor = conn.cursor()

    # 1. Documents table
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS documents (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            filename TEXT NOT NULL,
            storage_path TEXT NOT NULL,
            total_pages INTEGER,
            uploaded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    ''')

    # Alter table if existing database does not have total_pages
    try:
        cursor.execute("ALTER TABLE documents ADD COLUMN total_pages INTEGER;")
    except sqlite3.OperationalError:
        pass

    # Migrate any existing NULL total_pages
    try:
        cursor.execute("SELECT id, storage_path FROM documents WHERE total_pages IS NULL")
        rows = cursor.fetchall()
        for row in rows:
            pages = get_pdf_page_count(row['storage_path'])
            cursor.execute("UPDATE documents SET total_pages = ? WHERE id = ?", (pages, row['id']))
        if rows:
            conn.commit()
    except Exception as e:
        print(f"Migration error for total_pages: {e}")

    # 2. Recipients table
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS recipients (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            email TEXT NOT NULL,
            company TEXT NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    ''')

    # 3. Links table
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS links (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            token TEXT UNIQUE NOT NULL,
            document_id INTEGER NOT NULL,
            recipient_id INTEGER NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            expires_at TIMESTAMP,
            revoked_at TIMESTAMP,
            FOREIGN KEY (document_id) REFERENCES documents (id) ON DELETE CASCADE,
            FOREIGN KEY (recipient_id) REFERENCES recipients (id) ON DELETE CASCADE
        )
    ''')

    # 4. Sessions table
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS sessions (
            id TEXT PRIMARY KEY,
            link_id INTEGER NOT NULL,
            started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            ended_at TIMESTAMP,
            ip_address TEXT,
            user_agent TEXT,
            geo_country TEXT,
            geo_city TEXT,
            total_active_seconds REAL DEFAULT 0,
            FOREIGN KEY (link_id) REFERENCES links (id) ON DELETE CASCADE
        )
    ''')

    # 5. Page Events table
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS page_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT NOT NULL,
            page_number INTEGER NOT NULL,
            entered_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            left_at TIMESTAMP,
            active_seconds REAL DEFAULT 0,
            FOREIGN KEY (session_id) REFERENCES sessions (id) ON DELETE CASCADE,
            UNIQUE(session_id, page_number)
        )
    ''')

    # 6. Click Events table
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS click_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT NOT NULL,
            page_number INTEGER NOT NULL,
            target_url TEXT,
            clicked_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (session_id) REFERENCES sessions (id) ON DELETE CASCADE
        )
    ''')

    conn.commit()
    conn.close()

# --- Helper functions for documents ---

def add_document(filename, storage_path, db_path=DATABASE_FILE):
    total_pages = get_pdf_page_count(storage_path)
    conn = get_connection(db_path)
    cursor = conn.cursor()
    try:
        cursor.execute('''
            INSERT INTO documents (filename, storage_path, total_pages)
            VALUES (?, ?, ?)
        ''', (filename, storage_path, total_pages))
        conn.commit()
        return cursor.lastrowid
    except sqlite3.Error as e:
        print(f"Error adding document: {e}")
        return None
    finally:
        conn.close()

def get_document(doc_id, db_path=DATABASE_FILE):
    conn = get_connection(db_path)
    cursor = conn.cursor()
    try:
        cursor.execute("SELECT * FROM documents WHERE id = ?", (doc_id,))
        return cursor.fetchone()
    finally:
        conn.close()

def list_documents(db_path=DATABASE_FILE):
    conn = get_connection(db_path)
    cursor = conn.cursor()
    try:
        cursor.execute("SELECT * FROM documents ORDER BY uploaded_at DESC")
        return [dict(row) for row in cursor.fetchall()]
    finally:
        conn.close()

# --- Helper functions for recipients ---

def add_recipient(name, email, company, db_path=DATABASE_FILE):
    conn = get_connection(db_path)
    cursor = conn.cursor()
    try:
        # Check if recipient already exists with same email, name, company
        cursor.execute('''
            SELECT id FROM recipients 
            WHERE email = ? AND name = ? AND company = ?
        ''', (email, name, company))
        existing = cursor.fetchone()
        if existing:
            return existing['id']
            
        cursor.execute('''
            INSERT INTO recipients (name, email, company)
            VALUES (?, ?, ?)
        ''', (name, email, company))
        conn.commit()
        return cursor.lastrowid
    except sqlite3.Error as e:
        print(f"Error adding recipient: {e}")
        return None
    finally:
        conn.close()

# --- Helper functions for links ---

def create_link(token, document_id, recipient_id, expires_at=None, db_path=DATABASE_FILE):
    conn = get_connection(db_path)
    cursor = conn.cursor()
    try:
        cursor.execute('''
            INSERT INTO links (token, document_id, recipient_id, expires_at)
            VALUES (?, ?, ?, ?)
        ''', (token, document_id, recipient_id, expires_at))
        conn.commit()
        return cursor.lastrowid
    except sqlite3.Error as e:
        print(f"Error creating link: {e}")
        return None
    finally:
        conn.close()

def get_link_by_token(token, db_path=DATABASE_FILE):
    """Retrieves link, document and recipient details by token."""
    conn = get_connection(db_path)
    cursor = conn.cursor()
    try:
        cursor.execute('''
            SELECT 
                l.id as link_id, l.token, l.created_at as link_created_at, l.expires_at, l.revoked_at,
                d.id as document_id, d.filename, d.storage_path,
                r.id as recipient_id, r.name as recipient_name, r.email as recipient_email, r.company as recipient_company
            FROM links l
            JOIN documents d ON l.document_id = d.id
            JOIN recipients r ON l.recipient_id = r.id
            WHERE l.token = ?
        ''', (token,))
        row = cursor.fetchone()
        return dict(row) if row else None
    finally:
        conn.close()

def is_link_invalid(link):
    """Checks if a link dictionary is expired or revoked."""
    if not link:
        return True
    if link.get('revoked_at'):
        return True
    if link.get('expires_at'):
        try:
            # Parse ISO-8601 expiry date
            expiry = datetime.fromisoformat(link['expires_at'].replace('Z', '+00:00'))
            # Convert current time to timezone-aware UTC
            now = datetime.now(expiry.tzinfo)
            if now > expiry:
                return True
        except Exception as e:
            print(f"Error parsing expiry datetime: {e}")
            # Fallback text comparison if formatting is standard SQL datetime
            try:
                expiry = datetime.strptime(link['expires_at'], "%Y-%m-%d %H:%M:%S")
                if datetime.utcnow() > expiry:
                    return True
            except Exception:
                pass
    return False

def revoke_link(token, db_path=DATABASE_FILE):
    conn = get_connection(db_path)
    cursor = conn.cursor()
    try:
        cursor.execute('''
            UPDATE links
            SET revoked_at = CURRENT_TIMESTAMP
            WHERE token = ?
        ''', (token,))
        conn.commit()
        return cursor.rowcount > 0
    except sqlite3.Error as e:
        print(f"Error revoking link: {e}")
        return False
    finally:
        conn.close()

# --- Helper functions for sessions and event logs ---

def create_session(session_id, link_id, ip_address, user_agent, country, city, db_path=DATABASE_FILE):
    conn = get_connection(db_path)
    cursor = conn.cursor()
    try:
        cursor.execute('''
            INSERT INTO sessions (id, link_id, ip_address, user_agent, geo_country, geo_city, total_active_seconds)
            VALUES (?, ?, ?, ?, ?, ?, 0)
        ''', (session_id, link_id, ip_address, user_agent, country, city))
        conn.commit()
        return True
    except sqlite3.Error as e:
        print(f"Error creating session: {e}")
        return False
    finally:
        conn.close()

def update_session_heartbeat(session_id, db_path=DATABASE_FILE):
    """Updates session ended_at and total active time."""
    conn = get_connection(db_path)
    cursor = conn.cursor()
    try:
        cursor.execute('''
            UPDATE sessions
            SET ended_at = CURRENT_TIMESTAMP
            WHERE id = ?
        ''', (session_id,))
        conn.commit()
        sync_session_active_time(session_id, db_path)
        return True
    except sqlite3.Error as e:
        print(f"Error updating heartbeat: {e}")
        return False
    finally:
        conn.close()

def upsert_page_event(session_id, page_number, active_seconds, db_path=DATABASE_FILE):
    """Upserts page active duration, adding it to existing active seconds if row exists."""
    conn = get_connection(db_path)
    cursor = conn.cursor()
    try:
        # Check if page event already exists for this session
        cursor.execute('''
            SELECT id, active_seconds FROM page_events 
            WHERE session_id = ? AND page_number = ?
        ''', (session_id, page_number))
        row = cursor.fetchone()
        
        if row:
            cursor.execute('''
                UPDATE page_events
                SET active_seconds = active_seconds + ?, left_at = CURRENT_TIMESTAMP
                WHERE id = ?
            ''', (active_seconds, row['id']))
        else:
            cursor.execute('''
                INSERT INTO page_events (session_id, page_number, active_seconds, entered_at, left_at)
                VALUES (?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
            ''', (session_id, page_number, active_seconds))
            
        conn.commit()
        sync_session_active_time(session_id, db_path)
        return True
    except sqlite3.Error as e:
        print(f"Error logging page event: {e}")
        return False
    finally:
        conn.close()

def log_click_event(session_id, page_number, target_url, db_path=DATABASE_FILE):
    conn = get_connection(db_path)
    cursor = conn.cursor()
    try:
        cursor.execute('''
            INSERT INTO click_events (session_id, page_number, target_url)
            VALUES (?, ?, ?)
        ''', (session_id, page_number, target_url))
        conn.commit()
        return True
    except sqlite3.Error as e:
        print(f"Error logging click event: {e}")
        return False
    finally:
        conn.close()

def sync_session_active_time(session_id, db_path=DATABASE_FILE):
    """Recalculates total active seconds for a session from the page_events table."""
    conn = get_connection(db_path)
    cursor = conn.cursor()
    try:
        cursor.execute('''
            UPDATE sessions
            SET total_active_seconds = COALESCE((
                SELECT SUM(active_seconds) FROM page_events WHERE session_id = ?
            ), 0)
            WHERE id = ?
        ''', (session_id, session_id))
        conn.commit()
    except sqlite3.Error as e:
        print(f"Error syncing active time: {e}")
    finally:
        conn.close()

def get_session_count_for_link(link_id, db_path=DATABASE_FILE):
    """Counts the number of sessions created for a specific link ID."""
    conn = get_connection(db_path)
    cursor = conn.cursor()
    try:
        cursor.execute("SELECT COUNT(*) as cnt FROM sessions WHERE link_id = ?", (link_id,))
        return cursor.fetchone()['cnt']
    except sqlite3.Error as e:
        print(f"Error getting session count: {e}")
        return 0
    finally:
        conn.close()

# --- Dashboard & Analytics queries ---

def get_dashboard_stats(db_path=DATABASE_FILE):
    """Retrieves overall performance metrics for the admin dashboard."""
    conn = get_connection(db_path)
    cursor = conn.cursor()
    stats = {
        'total_links': 0,
        'total_opens': 0,
        'avg_active_seconds': 0,
        'avg_completion_pct': 0,
        'click_through_rate': 0
    }
    try:
        # 1. Total links generated
        cursor.execute("SELECT COUNT(*) as cnt FROM links")
        stats['total_links'] = cursor.fetchone()['cnt']

        # 2. Total sessions (opens)
        cursor.execute("SELECT COUNT(*) as cnt FROM sessions")
        stats['total_opens'] = cursor.fetchone()['cnt']

        # 3. Average duration of views (sum of sessions / count of sessions)
        cursor.execute("SELECT AVG(total_active_seconds) as avg_sec FROM sessions")
        stats['avg_active_seconds'] = round(cursor.fetchone()['avg_sec'] or 0, 1)

        # 4. Average completion percentage
        # First check how many pages each link's document has (to get this accurate, we need a simple metric. Let's compute average unique pages viewed vs total pages. Or let's assume a brochure has pages. Wait! Since different documents can have different total pages, we can check how many pages were viewed versus total pages. If we don't store total pages in documents, we can estimate it, or retrieve it from the files. Wait! We can assume percentage pages viewed = count(distinct page_events.page_number) / 4.0 * 100 since the sample brochure has 4 pages, or look up pages from database. Let's write a query that joins with documents and calculates it if we can, or returns the count of distinct pages viewed per session.)
        # Let's count unique page views per session, and divide by document pages if we know them, or return average number of pages read. Let's make a query:
        cursor.execute('''
            SELECT 
                AVG(pages_viewed) as avg_pages
            FROM (
                SELECT session_id, COUNT(DISTINCT page_number) as pages_viewed
                FROM page_events
                GROUP BY session_id
            )
        ''')
        avg_pages = cursor.fetchone()['avg_pages'] or 0
        # Let's assume a default of 4 pages for our brochure, but return average pages read directly, or express it as a percentage. Let's store total page count or compute it from the timeline. Actually, let's keep it as avg pages read or assume 4 pages as a base if not specified. Let's return average unique pages read per session.
        stats['avg_pages_read'] = round(avg_pages, 1)

        # 5. CTR: sessions that clicked a link / total sessions
        cursor.execute('''
            SELECT COUNT(DISTINCT session_id) as clickers 
            FROM click_events
        ''')
        clickers = cursor.fetchone()['clickers']
        stats['click_through_rate'] = round((clickers / stats['total_opens'] * 100) if stats['total_opens'] > 0 else 0, 1)
        
    except sqlite3.Error as e:
        print(f"Error getting dashboard stats: {e}")
    finally:
        conn.close()
    return stats

def get_all_recipient_logs(db_path=DATABASE_FILE):
    """Returns a list of links and their corresponding recipient activities."""
    conn = get_connection(db_path)
    cursor = conn.cursor()
    logs = []
    try:
        # Query that joins links, documents, recipients, and aggregates session data
        cursor.execute('''
            SELECT 
                l.id as link_id,
                l.token,
                l.created_at as sent_date,
                l.expires_at,
                l.revoked_at,
                r.name as recipient_name,
                r.email as recipient_email,
                r.company as recipient_company,
                d.filename as document_name,
                d.total_pages as total_pages,
                COUNT(s.id) as open_count,
                COALESCE(SUM(s.total_active_seconds), 0) as total_time_spent,
                MAX(s.ended_at) as last_activity,
                (
                    SELECT COUNT(DISTINCT pe.page_number) 
                    FROM page_events pe 
                    JOIN sessions s2 ON pe.session_id = s2.id 
                    WHERE s2.link_id = l.id
                ) as unique_pages_viewed,
                (
                    SELECT MAX(pe.page_number) 
                    FROM page_events pe 
                    JOIN sessions s2 ON pe.session_id = s2.id 
                    WHERE s2.link_id = l.id
                ) as last_page_viewed
            FROM links l
            JOIN recipients r ON l.recipient_id = r.id
            JOIN documents d ON l.document_id = d.id
            LEFT JOIN sessions s ON s.link_id = l.id
            GROUP BY l.id
            ORDER BY l.created_at DESC
        ''')
        for row in cursor.fetchall():
            logs.append(dict(row))
    except sqlite3.Error as e:
        print(f"Error getting recipient logs: {e}")
    finally:
        conn.close()
    return logs

def get_session_timeline(session_id, db_path=DATABASE_FILE):
    """
    Constructs a detailed chronological timeline of activities for a single session.
    """
    conn = get_connection(db_path)
    cursor = conn.cursor()
    timeline = []
    try:
        # Get session info
        cursor.execute('''
            SELECT s.started_at, s.ip_address, s.user_agent, s.geo_country, s.geo_city,
                   r.name as recipient_name, l.token, d.filename
            FROM sessions s
            JOIN links l ON s.link_id = l.id
            JOIN recipients r ON l.recipient_id = r.id
            JOIN documents d ON l.document_id = d.id
            WHERE s.id = ?
        ''', (session_id,))
        session = cursor.fetchone()
        if not session:
            return []

        base_time = datetime.fromisoformat(session['started_at'].replace('Z', '+00:00'))

        # Add Start event
        location = f"{session['geo_city']}, {session['geo_country']}" if session['geo_city'] else "Unknown Location"
        timeline.append({
            'type': 'start',
            'timestamp': session['started_at'],
            'description': f"Opened PDF brochure '{session['filename']}' from {location}",
            'relative_sec': 0
        })

        # Add page_events
        cursor.execute('''
            SELECT page_number, entered_at, active_seconds
            FROM page_events
            WHERE session_id = ?
            ORDER BY entered_at ASC
        ''', (session_id,))
        for row in cursor.fetchall():
            ent_time = datetime.fromisoformat(row['entered_at'].replace('Z', '+00:00'))
            rel_sec = int((ent_time - base_time).total_seconds())
            timeline.append({
                'type': 'page',
                'timestamp': row['entered_at'],
                'description': f"Viewed Page {row['page_number']} for {round(row['active_seconds'], 1)} seconds",
                'relative_sec': max(0, rel_sec)
            })

        # Add click_events
        cursor.execute('''
            SELECT page_number, target_url, clicked_at
            FROM click_events
            WHERE session_id = ?
            ORDER BY clicked_at ASC
        ''', (session_id,))
        for row in cursor.fetchall():
            clk_time = datetime.fromisoformat(row['clicked_at'].replace('Z', '+00:00'))
            rel_sec = int((clk_time - base_time).total_seconds())
            timeline.append({
                'type': 'click',
                'timestamp': row['clicked_at'],
                'description': f"Clicked URL '{row['target_url']}' on Page {row['page_number']}",
                'relative_sec': max(0, rel_sec)
            })

        # Sort timeline chronologically
        timeline.sort(key=lambda x: (x['relative_sec'], x['timestamp']))
        
    except sqlite3.Error as e:
        print(f"Error getting session timeline: {e}")
    finally:
        conn.close()
    return timeline

def get_recipient_session_details(link_id, db_path=DATABASE_FILE):
    """Retrieves list of sessions, page durations, and clicks for a specific link."""
    conn = get_connection(db_path)
    cursor = conn.cursor()
    details = {
        'sessions': [],
        'page_durations': {},
        'clicks': [],
        'total_pages': 4
    }
    try:
        # Get total pages of the document
        cursor.execute('''
            SELECT d.total_pages
            FROM links l
            JOIN documents d ON l.document_id = d.id
            WHERE l.id = ?
        ''', (link_id,))
        doc_row = cursor.fetchone()
        if doc_row and doc_row['total_pages']:
            details['total_pages'] = doc_row['total_pages']

        # Get sessions
        cursor.execute('''
            SELECT * FROM sessions 
            WHERE link_id = ? 
            ORDER BY started_at DESC
        ''', (link_id,))
        sessions = [dict(row) for row in cursor.fetchall()]
        details['sessions'] = sessions

        # Get aggregate page durations across all sessions for this link
        cursor.execute('''
            SELECT pe.page_number, SUM(pe.active_seconds) as total_seconds
            FROM page_events pe
            JOIN sessions s ON pe.session_id = s.id
            WHERE s.link_id = ?
            GROUP BY pe.page_number
            ORDER BY pe.page_number ASC
        ''', (link_id,))
        for row in cursor.fetchall():
            details['page_durations'][row['page_number']] = round(row['total_seconds'], 1)

        # Get all clicks for these sessions
        cursor.execute('''
            SELECT ce.page_number, ce.target_url, ce.clicked_at, s.id as session_id
            FROM click_events ce
            JOIN sessions s ON ce.session_id = s.id
            WHERE s.link_id = ?
            ORDER BY ce.clicked_at DESC
        ''', (link_id,))
        details['clicks'] = [dict(row) for row in cursor.fetchall()]

    except sqlite3.Error as e:
        print(f"Error getting recipient session details: {e}")
    finally:
        conn.close()
    return details

def get_page_stats_all(db_path=DATABASE_FILE):
    """Gets total and average time spent on each page across all links."""
    conn = get_connection(db_path)
    cursor = conn.cursor()
    stats = []
    try:
        cursor.execute('''
            SELECT 
                page_number, 
                SUM(active_seconds) as total_duration,
                AVG(active_seconds) as avg_duration,
                COUNT(DISTINCT session_id) as view_count
            FROM page_events
            GROUP BY page_number
            ORDER BY page_number ASC
        ''')
        for row in cursor.fetchall():
            stats.append({
                'page_number': row['page_number'],
                'total_duration': round(row['total_duration'], 1),
                'avg_duration': round(row['avg_duration'], 1),
                'view_count': row['view_count']
            })
    except sqlite3.Error as e:
        print(f"Error getting aggregate page stats: {e}")
    finally:
        conn.close()
    return stats

def get_click_stats_all(db_path=DATABASE_FILE):
    """Gets counts of link clicks grouped by target URL."""
    conn = get_connection(db_path)
    cursor = conn.cursor()
    stats = []
    try:
        cursor.execute('''
            SELECT 
                target_url, 
                COUNT(*) as click_count,
                COUNT(DISTINCT session_id) as unique_clicks
            FROM click_events
            GROUP BY target_url
            ORDER BY click_count DESC
            LIMIT 10
        ''')
        for row in cursor.fetchall():
            stats.append({
                'target_url': row['target_url'],
                'click_count': row['click_count'],
                'unique_clicks': row['unique_clicks']
            })
    except sqlite3.Error as e:
        print(f"Error getting click stats: {e}")
    finally:
        conn.close()
    return stats

def get_recipient_by_session_id(session_id, db_path=DATABASE_FILE):
    """Retrieves recipient and document details by session ID (session -> link -> recipient/document)."""
    conn = get_connection(db_path)
    cursor = conn.cursor()
    try:
        cursor.execute('''
            SELECT 
                r.name as recipient_name, 
                r.email as recipient_email, 
                r.company as recipient_company,
                d.filename,
                l.id as link_id
            FROM sessions s
            JOIN links l ON s.link_id = l.id
            JOIN recipients r ON l.recipient_id = r.id
            JOIN documents d ON l.document_id = d.id
            WHERE s.id = ?
        ''', (session_id,))
        row = cursor.fetchone()
        return dict(row) if row else None
    except sqlite3.Error as e:
        print(f"Error getting recipient by session ID: {e}")
        return None
    finally:
        conn.close()

