import sqlite3
import os
import re
import json
from datetime import datetime

DATABASE_FILE = os.environ.get("DATABASE_PATH", "analytics.db")

def get_connection(db_path=DATABASE_FILE):
    """Returns a connection to the SQLite database with row factory enabled."""
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON;")
    return conn

def get_pdf_page_count(file_path):
    """Robustly counts total pages in a PDF file by parsing binary content."""
    try:
        if not file_path or not os.path.exists(file_path):
            return 4
        with open(file_path, 'rb') as f:
            content = f.read()
        matches = re.findall(br'/Count\s*(\d+)', content)
        if matches:
            return max(int(m) for m in matches)
        page_matches = re.findall(br'/Type\s*/Page\b', content)
        if page_matches:
            return len(page_matches)
    except Exception as e:
        print(f"Error reading PDF page count for {file_path}: {e}")
    return 4

def init_db(db_path=DATABASE_FILE):
    """Initializes the database schema if it doesn't already exist."""
    conn = get_connection(db_path)
    cursor = conn.cursor()

    # 1. Documents table (Added doc_type and metadata)
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS documents (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            filename TEXT NOT NULL,
            storage_path TEXT NOT NULL,
            total_pages INTEGER,
            doc_type TEXT DEFAULT 'pdf',
            metadata TEXT,
            uploaded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    ''')
    try:
        cursor.execute("ALTER TABLE documents ADD COLUMN doc_type TEXT DEFAULT 'pdf';")
        cursor.execute("ALTER TABLE documents ADD COLUMN metadata TEXT;")
    except sqlite3.OperationalError:
        pass
    
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
    # We keep document_id for backwards compatibility, but it's largely superseded by link_documents
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS links (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            token TEXT UNIQUE NOT NULL,
            document_id INTEGER,
            recipient_id INTEGER NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            expires_at TIMESTAMP,
            revoked_at TIMESTAMP,
            FOREIGN KEY (document_id) REFERENCES documents (id) ON DELETE SET NULL,
            FOREIGN KEY (recipient_id) REFERENCES recipients (id) ON DELETE CASCADE
        )
    ''')

    # 3.5. Link Documents (Many-to-many)
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS link_documents (
            link_id INTEGER NOT NULL,
            document_id INTEGER NOT NULL,
            FOREIGN KEY (link_id) REFERENCES links (id) ON DELETE CASCADE,
            FOREIGN KEY (document_id) REFERENCES documents (id) ON DELETE CASCADE,
            PRIMARY KEY (link_id, document_id)
        )
    ''')

    # Migrate links to link_documents
    try:
        cursor.execute("INSERT OR IGNORE INTO link_documents (link_id, document_id) SELECT id, document_id FROM links WHERE document_id IS NOT NULL")
    except Exception as e:
        print(f"Migration error for link_documents: {e}")

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
    # Needs document_id and a new unique constraint. We'll recreate if it doesn't have document_id
    cursor.execute("PRAGMA table_info(page_events)")
    columns = [row['name'] for row in cursor.fetchall()]
    
    if columns and 'document_id' not in columns:
        print("Migrating page_events table to include document_id...")
        cursor.execute('''
            CREATE TABLE page_events_new (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id TEXT NOT NULL,
                document_id INTEGER NOT NULL,
                page_number INTEGER NOT NULL,
                entered_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                left_at TIMESTAMP,
                active_seconds REAL DEFAULT 0,
                FOREIGN KEY (session_id) REFERENCES sessions (id) ON DELETE CASCADE,
                FOREIGN KEY (document_id) REFERENCES documents (id) ON DELETE CASCADE,
                UNIQUE(session_id, document_id, page_number)
            )
        ''')
        cursor.execute('''
            INSERT INTO page_events_new (id, session_id, document_id, page_number, entered_at, left_at, active_seconds)
            SELECT pe.id, pe.session_id, COALESCE(l.document_id, 1), pe.page_number, pe.entered_at, pe.left_at, pe.active_seconds
            FROM page_events pe
            JOIN sessions s ON pe.session_id = s.id
            JOIN links l ON s.link_id = l.id
        ''')
        cursor.execute("DROP TABLE page_events")
        cursor.execute("ALTER TABLE page_events_new RENAME TO page_events")
    else:
        cursor.execute('''
            CREATE TABLE IF NOT EXISTS page_events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id TEXT NOT NULL,
                document_id INTEGER NOT NULL,
                page_number INTEGER NOT NULL,
                entered_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                left_at TIMESTAMP,
                active_seconds REAL DEFAULT 0,
                FOREIGN KEY (session_id) REFERENCES sessions (id) ON DELETE CASCADE,
                FOREIGN KEY (document_id) REFERENCES documents (id) ON DELETE CASCADE,
                UNIQUE(session_id, document_id, page_number)
            )
        ''')

    # 6. Click Events table
    # Also add document_id
    cursor.execute("PRAGMA table_info(click_events)")
    click_columns = [row['name'] for row in cursor.fetchall()]
    if click_columns and 'document_id' not in click_columns:
        print("Migrating click_events table to include document_id...")
        cursor.execute('''
            CREATE TABLE click_events_new (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id TEXT NOT NULL,
                document_id INTEGER NOT NULL,
                page_number INTEGER,
                target_url TEXT,
                clicked_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (session_id) REFERENCES sessions (id) ON DELETE CASCADE,
                FOREIGN KEY (document_id) REFERENCES documents (id) ON DELETE CASCADE
            )
        ''')
        cursor.execute('''
            INSERT INTO click_events_new (id, session_id, document_id, page_number, target_url, clicked_at)
            SELECT ce.id, ce.session_id, COALESCE(l.document_id, 1), ce.page_number, ce.target_url, ce.clicked_at
            FROM click_events ce
            JOIN sessions s ON ce.session_id = s.id
            JOIN links l ON s.link_id = l.id
        ''')
        cursor.execute("DROP TABLE click_events")
        cursor.execute("ALTER TABLE click_events_new RENAME TO click_events")
    else:
        cursor.execute('''
            CREATE TABLE IF NOT EXISTS click_events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id TEXT NOT NULL,
                document_id INTEGER NOT NULL,
                page_number INTEGER,
                target_url TEXT,
                clicked_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (session_id) REFERENCES sessions (id) ON DELETE CASCADE,
                FOREIGN KEY (document_id) REFERENCES documents (id) ON DELETE CASCADE
            )
        ''')

    # 7. Component Events table (for Videos, Whiteboards, etc.)
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS component_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT NOT NULL,
            document_id INTEGER NOT NULL,
            event_type TEXT NOT NULL,
            active_seconds REAL DEFAULT 0,
            event_data TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (session_id) REFERENCES sessions (id) ON DELETE CASCADE,
            FOREIGN KEY (document_id) REFERENCES documents (id) ON DELETE CASCADE
        )
    ''')

    conn.commit()
    conn.close()

# --- Helpers ---
def add_document(filename, storage_path, doc_type='pdf', metadata=None, db_path=DATABASE_FILE):
    total_pages = get_pdf_page_count(storage_path) if doc_type == 'pdf' else None
    conn = get_connection(db_path)
    cursor = conn.cursor()
    try:
        cursor.execute('''
            INSERT INTO documents (filename, storage_path, total_pages, doc_type, metadata)
            VALUES (?, ?, ?, ?, ?)
        ''', (filename, storage_path, total_pages, doc_type, metadata))
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
        row = cursor.fetchone()
        return dict(row) if row else None
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

def delete_document(doc_id, db_path=DATABASE_FILE):
    """Deletes a document record and its physical file from storage."""
    import os
    conn = get_connection(db_path)
    cursor = conn.cursor()
    try:
        cursor.execute("SELECT storage_path, doc_type FROM documents WHERE id = ?", (doc_id,))
        row = cursor.fetchone()
        if not row:
            return False, "Document not found"

        # Delete the physical file (skip for external links which have no real file)
        storage_path = row["storage_path"]
        if row["doc_type"] != "link" and storage_path and os.path.exists(storage_path):
            try:
                os.remove(storage_path)
            except OSError as e:
                print(f"Warning: could not delete file {storage_path}: {e}")

        # Remove from DB (cascade will clean up link_documents references if FK is ON)
        cursor.execute("DELETE FROM link_documents WHERE document_id = ?", (doc_id,))
        cursor.execute("DELETE FROM documents WHERE id = ?", (doc_id,))
        conn.commit()
        return True, "Deleted"
    except sqlite3.Error as e:
        print(f"Error deleting document {doc_id}: {e}")
        return False, str(e)
    finally:
        conn.close()

def add_recipient(name, email, company, db_path=DATABASE_FILE):
    conn = get_connection(db_path)
    cursor = conn.cursor()
    try:
        cursor.execute('SELECT id FROM recipients WHERE email = ? AND name = ? AND company = ?', (email, name, company))
        existing = cursor.fetchone()
        if existing: return existing['id']
            
        cursor.execute('INSERT INTO recipients (name, email, company) VALUES (?, ?, ?)', (name, email, company))
        conn.commit()
        return cursor.lastrowid
    except sqlite3.Error as e:
        print(f"Error adding recipient: {e}")
        return None
    finally:
        conn.close()

def create_link(token, document_ids, recipient_id, expires_at=None, db_path=DATABASE_FILE):
    if not document_ids:
        return None
    conn = get_connection(db_path)
    cursor = conn.cursor()
    try:
        first_doc = document_ids[0]
        cursor.execute('''
            INSERT INTO links (token, document_id, recipient_id, expires_at)
            VALUES (?, ?, ?, ?)
        ''', (token, first_doc, recipient_id, expires_at))
        link_id = cursor.lastrowid
        
        for doc_id in document_ids:
            cursor.execute('''
                INSERT INTO link_documents (link_id, document_id)
                VALUES (?, ?)
            ''', (link_id, doc_id))
        
        conn.commit()
        return link_id
    except sqlite3.Error as e:
        print(f"Error creating link: {e}")
        return None
    finally:
        conn.close()

def get_link_by_token(token, db_path=DATABASE_FILE):
    conn = get_connection(db_path)
    cursor = conn.cursor()
    try:
        cursor.execute('''
            SELECT 
                l.id as link_id, l.token, l.created_at as link_created_at, l.expires_at, l.revoked_at,
                r.id as recipient_id, r.name as recipient_name, r.email as recipient_email, r.company as recipient_company
            FROM links l
            JOIN recipients r ON l.recipient_id = r.id
            WHERE l.token = ?
        ''', (token,))
        link_row = cursor.fetchone()
        if not link_row:
            return None
        
        link_data = dict(link_row)
        
        cursor.execute('''
            SELECT d.* 
            FROM link_documents ld
            JOIN documents d ON ld.document_id = d.id
            WHERE ld.link_id = ?
        ''', (link_data['link_id'],))
        
        link_data['documents'] = [dict(row) for row in cursor.fetchall()]
        
        if link_data['documents']:
            first_doc = link_data['documents'][0]
            link_data['document_id'] = first_doc['id']
            link_data['filename'] = first_doc['filename']
            link_data['storage_path'] = first_doc['storage_path']
            
        return link_data
    finally:
        conn.close()

def is_link_invalid(link):
    if not link: return True
    if link.get('revoked_at'): return True
    if link.get('expires_at'):
        try:
            expiry = datetime.fromisoformat(link['expires_at'].replace('Z', '+00:00'))
            now = datetime.now(expiry.tzinfo)
            if now > expiry: return True
        except:
            try:
                expiry = datetime.strptime(link['expires_at'], "%Y-%m-%d %H:%M:%S")
                if datetime.utcnow() > expiry: return True
            except: pass
    return False

def revoke_link(token, db_path=DATABASE_FILE):
    conn = get_connection(db_path)
    cursor = conn.cursor()
    try:
        cursor.execute("UPDATE links SET revoked_at = CURRENT_TIMESTAMP WHERE token = ?", (token,))
        conn.commit()
        return cursor.rowcount > 0
    except sqlite3.Error as e:
        print(f"Error revoking link: {e}")
        return False
    finally:
        conn.close()

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
    conn = get_connection(db_path)
    cursor = conn.cursor()
    try:
        cursor.execute("UPDATE sessions SET ended_at = CURRENT_TIMESTAMP WHERE id = ?", (session_id,))
        conn.commit()
        sync_session_active_time(session_id, db_path)
        return True
    except sqlite3.Error as e:
        print(f"Error updating heartbeat: {e}")
        return False
    finally:
        conn.close()

def upsert_page_event(session_id, document_id, page_number, active_seconds, db_path=DATABASE_FILE):
    conn = get_connection(db_path)
    cursor = conn.cursor()
    try:
        cursor.execute('''
            SELECT id, active_seconds FROM page_events 
            WHERE session_id = ? AND document_id = ? AND page_number = ?
        ''', (session_id, document_id, page_number))
        row = cursor.fetchone()
        
        if row:
            cursor.execute('''
                UPDATE page_events
                SET active_seconds = active_seconds + ?, left_at = CURRENT_TIMESTAMP
                WHERE id = ?
            ''', (active_seconds, row['id']))
        else:
            cursor.execute('''
                INSERT INTO page_events (session_id, document_id, page_number, active_seconds, entered_at, left_at)
                VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
            ''', (session_id, document_id, page_number, active_seconds))
            
        conn.commit()
        sync_session_active_time(session_id, db_path)
        return True
    except sqlite3.Error as e:
        print(f"Error logging page event: {e}")
        return False
    finally:
        conn.close()

def log_component_event(session_id, document_id, event_type, active_seconds, event_data=None, db_path=DATABASE_FILE):
    conn = get_connection(db_path)
    cursor = conn.cursor()
    try:
        if event_type == 'time_spent':
            cursor.execute('''
                SELECT id FROM component_events 
                WHERE session_id = ? AND document_id = ? AND event_type = ?
            ''', (session_id, document_id, event_type))
            row = cursor.fetchone()
            if row:
                cursor.execute('''
                    UPDATE component_events
                    SET active_seconds = active_seconds + ?
                    WHERE id = ?
                ''', (active_seconds, row['id']))
            else:
                cursor.execute('''
                    INSERT INTO component_events (session_id, document_id, event_type, active_seconds, event_data)
                    VALUES (?, ?, ?, ?, ?)
                ''', (session_id, document_id, event_type, active_seconds, event_data))
        else:
            cursor.execute('''
                INSERT INTO component_events (session_id, document_id, event_type, active_seconds, event_data)
                VALUES (?, ?, ?, ?, ?)
            ''', (session_id, document_id, event_type, active_seconds, event_data))
            
        conn.commit()
        sync_session_active_time(session_id, db_path)
        return True
    except sqlite3.Error as e:
        print(f"Error logging component event: {e}")
        return False
    finally:
        conn.close()

def log_click_event(session_id, document_id, page_number, target_url, db_path=DATABASE_FILE):
    conn = get_connection(db_path)
    cursor = conn.cursor()
    try:
        cursor.execute('''
            INSERT INTO click_events (session_id, document_id, page_number, target_url)
            VALUES (?, ?, ?, ?)
        ''', (session_id, document_id, page_number, target_url))
        conn.commit()
        return True
    except sqlite3.Error as e:
        print(f"Error logging click event: {e}")
        return False
    finally:
        conn.close()

def sync_session_active_time(session_id, db_path=DATABASE_FILE):
    conn = get_connection(db_path)
    cursor = conn.cursor()
    try:
        cursor.execute('''
            UPDATE sessions
            SET total_active_seconds = COALESCE((
                SELECT SUM(active_seconds) FROM page_events WHERE session_id = ?
            ), 0) + COALESCE((
                SELECT SUM(active_seconds) FROM component_events WHERE session_id = ? AND event_type = 'time_spent'
            ), 0)
            WHERE id = ?
        ''', (session_id, session_id, session_id))
        conn.commit()
    except sqlite3.Error as e:
        print(f"Error syncing active time: {e}")
    finally:
        conn.close()

def get_session_count_for_link(link_id, db_path=DATABASE_FILE):
    conn = get_connection(db_path)
    cursor = conn.cursor()
    try:
        cursor.execute("SELECT COUNT(*) as cnt FROM sessions WHERE link_id = ?", (link_id,))
        return cursor.fetchone()['cnt']
    except: return 0
    finally: conn.close()

def get_dashboard_stats(db_path=DATABASE_FILE):
    conn = get_connection(db_path)
    cursor = conn.cursor()
    stats = {
        'total_links': 0, 'total_opens': 0, 'avg_active_seconds': 0,
        'click_through_rate': 0, 'avg_pages_read': 0
    }
    try:
        cursor.execute("SELECT COUNT(*) as cnt FROM links")
        stats['total_links'] = cursor.fetchone()['cnt']
        cursor.execute("SELECT COUNT(*) as cnt FROM sessions")
        stats['total_opens'] = cursor.fetchone()['cnt']
        cursor.execute("SELECT AVG(total_active_seconds) as avg_sec FROM sessions")
        stats['avg_active_seconds'] = round(cursor.fetchone()['avg_sec'] or 0, 1)
        
        cursor.execute('''
            SELECT AVG(pages_viewed) as avg_pages
            FROM (
                SELECT session_id, COUNT(DISTINCT page_number) as pages_viewed
                FROM page_events GROUP BY session_id
            )
        ''')
        avg_pages = cursor.fetchone()['avg_pages'] or 0
        stats['avg_pages_read'] = round(avg_pages, 1)

        cursor.execute("SELECT COUNT(DISTINCT session_id) as clickers FROM click_events")
        clickers = cursor.fetchone()['clickers']
        stats['click_through_rate'] = round((clickers / stats['total_opens'] * 100) if stats['total_opens'] > 0 else 0, 1)
    except Exception as e: print(f"Stats Error: {e}")
    finally: conn.close()
    return stats

def get_all_recipient_logs(db_path=DATABASE_FILE):
    conn = get_connection(db_path)
    cursor = conn.cursor()
    logs = []
    try:
        cursor.execute('''
            SELECT 
                l.id as link_id, l.token, l.created_at as sent_date, l.expires_at, l.revoked_at,
                r.name as recipient_name, r.email as recipient_email, r.company as recipient_company,
                (SELECT GROUP_CONCAT(d2.filename, ', ') FROM link_documents ld2 JOIN documents d2 ON ld2.document_id = d2.id WHERE ld2.link_id = l.id) as document_name,
                COUNT(s.id) as open_count,
                COALESCE(SUM(s.total_active_seconds), 0) as total_time_spent,
                MAX(s.ended_at) as last_activity,
                (SELECT COUNT(DISTINCT pe.page_number) FROM page_events pe JOIN sessions s2 ON pe.session_id = s2.id WHERE s2.link_id = l.id) as unique_pages_viewed,
                (SELECT MAX(pe.page_number) FROM page_events pe JOIN sessions s2 ON pe.session_id = s2.id WHERE s2.link_id = l.id) as last_page_viewed
            FROM links l
            JOIN recipients r ON l.recipient_id = r.id
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
    conn = get_connection(db_path)
    cursor = conn.cursor()
    timeline = []
    try:
        cursor.execute('''
            SELECT s.started_at, s.ip_address, s.user_agent, s.geo_country, s.geo_city,
                   r.name as recipient_name, l.token
            FROM sessions s
            JOIN links l ON s.link_id = l.id
            JOIN recipients r ON l.recipient_id = r.id
            WHERE s.id = ?
        ''', (session_id,))
        session = cursor.fetchone()
        if not session: return []
        
        base_time = datetime.fromisoformat(session['started_at'].replace('Z', '+00:00'))
        location = f"{session['geo_city']}, {session['geo_country']}" if session['geo_city'] else "Unknown Location"
        timeline.append({
            'type': 'start',
            'timestamp': session['started_at'],
            'description': f"Opened Hub Link from {location}",
            'relative_sec': 0
        })

        cursor.execute('''
            SELECT pe.page_number, pe.entered_at, pe.active_seconds, d.filename
            FROM page_events pe
            JOIN documents d ON pe.document_id = d.id
            WHERE pe.session_id = ?
            ORDER BY pe.entered_at ASC
        ''', (session_id,))
        for row in cursor.fetchall():
            ent_time = datetime.fromisoformat(row['entered_at'].replace('Z', '+00:00'))
            timeline.append({
                'type': 'page',
                'timestamp': row['entered_at'],
                'description': f"Viewed Page {row['page_number']} of '{row['filename']}' for {round(row['active_seconds'], 1)} seconds",
                'relative_sec': max(0, int((ent_time - base_time).total_seconds()))
            })

        cursor.execute('''
            SELECT ce.event_type, ce.active_seconds, ce.created_at, d.filename, d.doc_type
            FROM component_events ce
            JOIN documents d ON ce.document_id = d.id
            WHERE ce.session_id = ?
            ORDER BY ce.created_at ASC
        ''', (session_id,))
        for row in cursor.fetchall():
            crt_time = datetime.fromisoformat(row['created_at'].replace('Z', '+00:00'))
            desc = ""
            if row['event_type'] == 'time_spent':
                desc = f"Interacted with '{row['filename']}' for {round(row['active_seconds'], 1)} seconds"
            else:
                desc = f"Performed '{row['event_type']}' on '{row['filename']}'"
            timeline.append({
                'type': 'component',
                'timestamp': row['created_at'],
                'description': desc,
                'relative_sec': max(0, int((crt_time - base_time).total_seconds()))
            })

        cursor.execute('''
            SELECT ce.page_number, ce.target_url, ce.clicked_at, d.filename
            FROM click_events ce
            JOIN documents d ON ce.document_id = d.id
            WHERE ce.session_id = ?
            ORDER BY ce.clicked_at ASC
        ''', (session_id,))
        for row in cursor.fetchall():
            clk_time = datetime.fromisoformat(row['clicked_at'].replace('Z', '+00:00'))
            timeline.append({
                'type': 'click',
                'timestamp': row['clicked_at'],
                'description': f"Clicked URL '{row['target_url']}' in '{row['filename']}'",
                'relative_sec': max(0, int((clk_time - base_time).total_seconds()))
            })

        timeline.sort(key=lambda x: (x['relative_sec'], x['timestamp']))
    except sqlite3.Error as e: print(f"Error getting session timeline: {e}")
    finally: conn.close()
    return timeline

def get_recipient_session_details(link_id, db_path=DATABASE_FILE):
    conn = get_connection(db_path)
    cursor = conn.cursor()
    details = {
        'sessions': [],
        'page_durations': {},
        'clicks': [],
        'component_times': {},
        'total_pages': 4
    }
    try:
        cursor.execute('SELECT * FROM sessions WHERE link_id = ? ORDER BY started_at DESC', (link_id,))
        details['sessions'] = [dict(row) for row in cursor.fetchall()]

        cursor.execute('''
            SELECT d.filename, pe.page_number, SUM(pe.active_seconds) as total_seconds
            FROM page_events pe
            JOIN sessions s ON pe.session_id = s.id
            JOIN documents d ON pe.document_id = d.id
            WHERE s.link_id = ?
            GROUP BY d.filename, pe.page_number
            ORDER BY d.filename, pe.page_number ASC
        ''', (link_id,))
        for row in cursor.fetchall():
            key = f"{row['filename']} - Page {row['page_number']}"
            details['page_durations'][key] = round(row['total_seconds'], 1)

        cursor.execute('''
            SELECT d.filename, SUM(ce.active_seconds) as total_seconds
            FROM component_events ce
            JOIN sessions s ON ce.session_id = s.id
            JOIN documents d ON ce.document_id = d.id
            WHERE s.link_id = ? AND ce.event_type = 'time_spent'
            GROUP BY d.filename
        ''', (link_id,))
        for row in cursor.fetchall():
            details['component_times'][row['filename']] = round(row['total_seconds'], 1)

        cursor.execute('''
            SELECT ce.page_number, ce.target_url, ce.clicked_at, s.id as session_id, d.filename
            FROM click_events ce
            JOIN sessions s ON ce.session_id = s.id
            JOIN documents d ON ce.document_id = d.id
            WHERE s.link_id = ?
            ORDER BY ce.clicked_at DESC
        ''', (link_id,))
        details['clicks'] = [dict(row) for row in cursor.fetchall()]

    except sqlite3.Error as e: print(f"Error details: {e}")
    finally: conn.close()
    return details

def get_page_stats_all(db_path=DATABASE_FILE):
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
    except: pass
    finally: conn.close()
    return stats

def get_click_stats_all(db_path=DATABASE_FILE):
    conn = get_connection(db_path)
    cursor = conn.cursor()
    stats = []
    try:
        cursor.execute('''
            SELECT target_url, COUNT(*) as click_count, COUNT(DISTINCT session_id) as unique_clicks
            FROM click_events
            GROUP BY target_url
            ORDER BY click_count DESC LIMIT 10
        ''')
        for row in cursor.fetchall(): stats.append(dict(row))
    except: pass
    finally: conn.close()
    return stats

def get_recipient_by_session_id(session_id, db_path=DATABASE_FILE):
    conn = get_connection(db_path)
    cursor = conn.cursor()
    try:
        cursor.execute('''
            SELECT 
                r.name as recipient_name, r.email as recipient_email, r.company as recipient_company,
                (SELECT GROUP_CONCAT(d2.filename, ', ') FROM link_documents ld2 JOIN documents d2 ON ld2.document_id = d2.id WHERE ld2.link_id = l.id) as filename,
                l.id as link_id, s.geo_country, s.geo_city
            FROM sessions s
            JOIN links l ON s.link_id = l.id
            JOIN recipients r ON l.recipient_id = r.id
            WHERE s.id = ?
        ''', (session_id,))
        row = cursor.fetchone()
        return dict(row) if row else None
    except: return None
    finally: conn.close()

def get_link_activity_summary(link_id, db_path=DATABASE_FILE):
    """Compiles a short text summary of all activities recorded on this link."""
    conn = get_connection(db_path)
    cursor = conn.cursor()
    summary = []
    session_count = 0
    try:
        # Get session count & total time
        cursor.execute("SELECT COUNT(*) as session_count, SUM(total_active_seconds) as total_time FROM sessions WHERE link_id = ?", (link_id,))
        row = cursor.fetchone()
        session_count = row['session_count'] or 0
        total_time = int(row['total_time'] or 0)
        
        time_str = ""
        if total_time >= 60:
            time_str = f"{total_time // 60}m {total_time % 60}s"
        else:
            time_str = f"{total_time}s"
            
        summary.append(f"• *Total visits:* {session_count} times")
        summary.append(f"• *Total time spent:* {time_str}")

        # Get pages read
        cursor.execute('''
            SELECT d.filename, COUNT(DISTINCT pe.page_number) as pages, SUM(pe.active_seconds) as dur
            FROM page_events pe
            JOIN sessions s ON pe.session_id = s.id
            JOIN documents d ON pe.document_id = d.id
            WHERE s.link_id = ?
            GROUP BY d.filename
        ''', (link_id,))
        pages_rows = cursor.fetchall()
        if pages_rows:
            summary.append("\n*Document Pages Read:*")
            for r in pages_rows:
                dur_str = f"{int(r['dur'])}s" if r['dur'] < 60 else f"{int(r['dur'] // 60)}m {int(r['dur'] % 60)}s"
                summary.append(f"  - `{r['filename']}`: Read {r['pages']} page(s) ({dur_str})")

        # Get video / component interactions
        cursor.execute('''
            SELECT d.filename, d.doc_type, ce.event_type, COUNT(*) as cnt, SUM(ce.active_seconds) as dur
            FROM component_events ce
            JOIN sessions s ON ce.session_id = s.id
            JOIN documents d ON ce.document_id = d.id
            WHERE s.link_id = ?
            GROUP BY d.filename, ce.event_type
        ''', (link_id,))
        comp_rows = cursor.fetchall()
        if comp_rows:
            summary.append("\n*Media & Link Clicks:*")
            for r in comp_rows:
                if r['event_type'] == 'play':
                    summary.append(f"  - Played video `{r['filename']}` ({r['cnt']} time(s))")
                elif r['event_type'] == 'pause':
                    pass
                else:
                    dur_str = f" for {int(r['dur'])}s" if r['dur'] > 0 else ""
                    summary.append(f"  - Interacted with `{r['filename']}` ({r['event_type']}){dur_str}")

        # Get link clicks
        cursor.execute('''
            SELECT ce.target_url, COUNT(*) as click_cnt
            FROM click_events ce
            JOIN sessions s ON ce.session_id = s.id
            WHERE s.link_id = ?
            GROUP BY ce.target_url
        ''', (link_id,))
        click_rows = cursor.fetchall()
        if click_rows:
            summary.append("\n*External URL Clicks:*")
            for r in click_rows:
                short_url = r['target_url']
                if len(short_url) > 40: short_url = short_url[:37] + "..."
                summary.append(f"  - Clicked <{r['target_url']}|{short_url}> ({r['click_cnt']} time(s))")

    except Exception as e:
        print(f"Error compiling link activity summary: {e}")
    finally:
        conn.close()
        
    if not summary or session_count <= 1:
        return "No prior activities recorded (this is their first visit!)."
    return "\n".join(summary)
