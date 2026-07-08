import os
import shutil
import time
import secrets
from datetime import datetime, timedelta
import database

def seed():
    print("Initializing SQLite database tables...")
    database.init_db()

    # Create storage directory
    base_dir = os.path.dirname(os.path.abspath(__file__))
    storage_dir = os.path.join(base_dir, 'storage')
    os.makedirs(storage_dir, exist_ok=True)

    # Look for the sample PDF
    sample_pdf_name = "pibit Brochure.pdf"
    sample_pdf_path = os.path.join(base_dir, sample_pdf_name)

    if not os.path.exists(sample_pdf_path):
        # Check static folder fallback
        static_pdf_path = os.path.join(base_dir, 'static', sample_pdf_name)
        if os.path.exists(static_pdf_path):
            sample_pdf_path = static_pdf_path
            print(f"Found sample PDF inside static folder: '{sample_pdf_path}'")
        else:
            print(f"Error: Sample brochure '{sample_pdf_name}' not found in root or static directory!")
            print("Please place a PDF brochure named 'pibit Brochure.pdf' in the root folder and run seed.py again.")
            return

    # Copy sample PDF to storage directory
    stored_filename = f"{int(time.time())}_seed_brochure.pdf"
    stored_path = os.path.join(storage_dir, stored_filename)
    
    print(f"Copying '{sample_pdf_name}' into storage directory: '{stored_path}'...")
    shutil.copy2(sample_pdf_path, stored_path)

    # 1. Add Document record
    print("Registering brochure document in database...")
    doc_id = database.add_document("pibit Brochure.pdf", stored_path)
    if not doc_id:
        print("Failed to register document in database.")
        return
    print(f"Brochure registered with Document ID: {doc_id}")

    # 2. Add Test Recipients
    test_recipients = [
        {
            "name": "John Doe",
            "email": "john@acme.com",
            "company": "Acme Corporation"
        },
        {
            "name": "Jane Smith",
            "email": "jane@alpha.org",
            "company": "Alpha Tech"
        },
        {
            "name": "Bob Miller",
            "email": "bob@millerfoods.co",
            "company": "Miller Foods"
        }
    ]

    print("\nRegistering test recipients and generating tracking links:")
    print("=" * 90)
    print(f"{'Recipient Name':<15} | {'Email':<22} | {'Company':<18} | {'Trackable Outreach Link'}")
    print("-" * 90)

    host_url = "http://localhost:5000"
    
    for rec in test_recipients:
        # Add recipient
        rec_id = database.add_recipient(rec['name'], rec['email'], rec['company'])
        if not rec_id:
            print(f"Failed to register recipient {rec['name']}")
            continue
            
        # Generate random unguessable token
        token = secrets.token_urlsafe(16)
        
        # Link expires in 30 days
        expiry_date = (datetime.utcnow() + timedelta(days=30)).isoformat()
        
        # Create link
        link_id = database.create_link(token, doc_id, rec_id, expiry_date)
        if link_id:
            tracking_link = f"{host_url}/v/{token}"
            print(f"{rec['name']:<15} | {rec['email']:<22} | {rec['company']:<18} | {tracking_link}")
        else:
            print(f"Failed to generate link for {rec['name']}")

    print("=" * 90)
    print("\nDatabase seeded successfully!")
    print("You can now start the web application by running: python app.py")

if __name__ == '__main__':
    seed()
