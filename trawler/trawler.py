import os
import json
import logging
from time import sleep
from datetime import datetime, timezone

import pytz
import requests
import websocket
from pymongo import MongoClient, ASCENDING
from dotenv import load_dotenv

# Load environment variables
load_dotenv()

# Logging setup
logging.basicConfig(level=logging.INFO, format="%(asctime)s - %(levelname)s - %(message)s")

# Terminal color codes
RED = "\033[91m"
RESET = "\033[0m"

# Environment variables
MONGO_URI = os.getenv("MONGO_URI")
MONGO_COLLECTION = os.getenv("MONGO_COLLECTION", "domains")  # default collection name

if not MONGO_URI:
    raise ValueError("MONGO_URI is required")

# MongoDB setup
mongo_client = MongoClient(MONGO_URI)
db = mongo_client.get_default_database()  # Gets DB from URI
collection = db[MONGO_COLLECTION]
collection.create_index([("domain", ASCENDING)], unique=True)

# Config
DISCORD_WEBHOOK_URL = os.getenv("DISCORD_WEBHOOK_URL")
KEYWORDS = [kw.strip() for kw in os.getenv("KEYWORDS", "").split(",") if kw.strip()]
TIMEZONE = pytz.timezone("Africa/Johannesburg")

def get_current_time_str() -> str:
    """Returns current timestamp in configured timezone."""
    return datetime.now(timezone.utc).astimezone(TIMEZONE).strftime("%Y-%m-%d %H:%M:%S")

def send_discord_alert(domain: str, received_at: str):
    """Send alert to Discord if webhook URL is configured."""
    if not DISCORD_WEBHOOK_URL:
        logging.warning("DISCORD_WEBHOOK_URL not set")
        return
    payload = {
        "content": f"⚠️ **Keyword match detected**\n**Domain:** `{domain}`\n**Time:** `{received_at}`"
    }
    response = requests.post(DISCORD_WEBHOOK_URL, json=payload)
    if response.status_code != 204:
        logging.warning("Failed to send to Discord: %s", response.text)

def save_to_db(message: str):
    """Parse and save message to MongoDB and send alert if keyword found."""
    try:
        data = json.loads(message)
        domain = data.get("domain", "").rstrip('.')
        if not domain:
            logging.warning("Invalid message received: %s", message)
            return

        received_at = get_current_time_str()

        document = {
            "domain": domain,
            "cert_index": data.get("cert_index"),
            "ct_name": data.get("ct_name"),
            "timestamp": data.get("timestamp"),
            "confidence": data.get("confidence"),
            "received_at": received_at
        }

        result = collection.update_one(
            {"domain": domain},
            {"$setOnInsert": document},
            upsert=True
        )
        if result.upserted_id:
            logging.info("Inserted new domain: %s", domain)
        else:
            logging.info("Domain already exists: %s", domain)

        if any(keyword.lower() in domain.lower() for keyword in KEYWORDS):
            logging.info(f"{RED}Keyword match found in domain: {domain}{RESET}")
            send_discord_alert(domain, received_at)

    except Exception as e:
        logging.error("Error saving to database: %s", e)

# WebSocket event handlers
def on_message(ws, message):
    logging.info("Received message")
    save_to_db(message)

def on_error(ws, error):
    logging.error("WebSocket error: %s", error)

def on_close(ws, close_status_code, close_msg):
    logging.warning("WebSocket closed: %s - %s", close_status_code, close_msg)
    reconnect()

def on_open(ws):
    logging.info("WebSocket connection opened")

def reconnect():
    logging.info("Reconnecting in 5 seconds...")
    sleep(5)
    start_websocket()

def start_websocket():
    websocket.enableTrace(False)
    ws = websocket.WebSocketApp(
        "wss://zonestream.openintel.nl/ws/confirmed_newly_registered_domain",
        on_message=on_message,
        on_error=on_error,
        on_close=on_close
    )
    ws.on_open = on_open
    ws.run_forever()

if __name__ == "__main__":
    start_websocket()

