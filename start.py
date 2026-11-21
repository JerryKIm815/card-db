import os
import sys
from pathlib import Path

password = os.environ.get('CARD_DB_PASSWORD')
if not password:
    sys.exit('CARD_DB_PASSWORD is required')
app = Path(__file__).with_name('card_db.py')
if not app.is_file():
    sys.exit('Upload card_db.py first')
os.execv(sys.executable, [sys.executable, str(app), '--host', '0.0.0.0', '--port', os.environ.get('PORT', '10000'), '--data', os.environ.get('CARD_DB_DATA', '/var/data'), '--password', password, '--no-browser', '--readonly'])
