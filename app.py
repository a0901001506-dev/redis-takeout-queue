import os
import re
from pathlib import Path
from uuid import uuid4

from flask import Flask, Response, abort, jsonify, make_response, redirect, render_template, request
from redis import Redis
from redis.exceptions import RedisError

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 8192
db = Redis.from_url(os.getenv("REDIS_URL", "redis://127.0.0.1:6379/0"),
                    protocol=2, decode_responses=True, socket_connect_timeout=3)
PREFIX = os.getenv("TAKEOUT_PREFIX", "takeout")
SEQUENCE = f"{PREFIX}:sequence"
ORDERS = f"{PREFIX}:orders"
ORDER_PREFIX = f"{PREFIX}:order:"
CHANNEL = f"{PREFIX}:updates"
MENU = {"dumplings": "水餃", "potstickers": "鍋貼"}
MAX_QUANTITY = 20
LUA = Path(__file__).parent / "redis_scripts"
create_order = db.register_script((LUA / "create.lua").read_text())
advance_order = db.register_script((LUA / "advance.lua").read_text())


def active_prefix():
    demo_id = request.args.get("demo")
    if demo_id is None:
        return PREFIX
    if not re.fullmatch(r"[a-f0-9]{32}", demo_id):
        abort(400)
    return f"{PREFIX}:demo:{demo_id}"


def read_orders(prefix=PREFIX):
    numbers = db.lrange(f"{prefix}:orders", 0, -1)
    with db.pipeline(transaction=False) as pipeline:
        for number in numbers:
            pipeline.hgetall(f"{prefix}:order:{number}")
        return [order for order in pipeline.execute() if order]


@app.get("/")
def home():
    return redirect("/demo")


@app.get("/demo")
def demo():
    response = make_response(render_template("demo.html", demo_id=uuid4().hex))
    response.headers["Cache-Control"] = "no-store"
    return response


@app.get("/order")
def ordering():
    return render_template("order.html", menu=MENU, max_quantity=MAX_QUANTITY)


@app.get("/staff")
def staff():
    return render_template("staff.html")


@app.get("/board")
def board():
    return redirect("/order#pickup-board")


@app.get("/api/state")
def get_state():
    orders = read_orders(active_prefix())
    if request.args.get("view") == "board":
        orders = [
            {"number": order["number"], "status": order["status"]}
            for order in orders if order["status"] != "collected"
        ]
    response = jsonify(orders=orders)
    response.headers["Cache-Control"] = "no-store"
    return response


@app.post("/api/orders")
def add_order():
    payload = request.get_json(silent=True)
    items = payload.get("items") if isinstance(payload, dict) else None
    if not isinstance(items, list) or not 1 <= len(items) <= len(MENU):
        return jsonify(error="請至少選擇一項餐點。"), 400

    quantities = {}
    for entry in items:
        if not isinstance(entry, dict):
            return jsonify(error="餐點格式有誤，請重新點餐。"), 400
        item_id, quantity = entry.get("id"), entry.get("quantity")
        if not isinstance(item_id, str) or item_id not in MENU or item_id in quantities:
            return jsonify(error="餐點有誤，請重新點餐。"), 400
        if type(quantity) is not int or not 1 <= quantity <= MAX_QUANTITY:
            return jsonify(error=f"每種餐點請選擇 1 至 {MAX_QUANTITY} 份。"), 400
        quantities[item_id] = quantity

    item = "、".join(f"{name} × {quantities[item_id]}"
                   for item_id, name in MENU.items() if item_id in quantities)
    prefix = active_prefix()
    keys = [f"{prefix}:sequence", f"{prefix}:orders", f"{prefix}:updates"]
    request_id = request.headers.get("Idempotency-Key")
    if request_id is not None:
        if not re.fullmatch(r"[a-zA-Z0-9_-]{16,80}", request_id):
            return jsonify(error="訂單識別碼有誤，請重新整理。"), 400
        keys.append(f"{prefix}:request:{request_id}")
    number = create_order(keys=keys, args=[f"{prefix}:order:", item])
    if not number:
        return jsonify(error="這個送出識別碼已用於另一筆訂單。"), 409
    return jsonify(order={"number": number, "item": item, "status": "preparing"}), 201


@app.post("/api/orders/<number>/<action>")
def update_order(number, action):
    previous = {"ready": "preparing", "collected": "ready"}.get(action)
    if previous is None:
        return jsonify(error="操作不存在。"), 404
    prefix = active_prefix()
    result = advance_order(keys=[f"{prefix}:order:{number}", f"{prefix}:updates"],
                           args=[previous, action])
    if result == -1:
        return jsonify(error="查無此訂單。"), 404
    if result == 0:
        return jsonify(error="訂單狀態已變更，請確認後再操作。"), 409
    return jsonify(ok=True)


@app.get("/api/events")
def events():
    channel = f"{active_prefix()}:updates"

    def stream():
        try:
            with db.pubsub() as subscriber:
                subscriber.subscribe(channel)
                while True:
                    notice = subscriber.get_message(timeout=15)
                    if notice is None:
                        yield ": heartbeat\n\n"
                    elif notice["type"] in {"subscribe", "message"}:
                        yield "data: changed\n\n"
        except RedisError:
            app.logger.warning("Redis event connection lost")
            yield "retry: 3000\n\n"

    return Response(stream(), mimetype="text/event-stream",
                    headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@app.errorhandler(RedisError)
def redis_unavailable(error):
    app.logger.warning("Redis operation failed (%s)", type(error).__name__)
    return jsonify(error="目前無法連線到 Redis，請確認資料庫已啟動。"), 503


if __name__ == "__main__":
    app.run(host=os.getenv("HOST", "127.0.0.1"),
            port=int(os.getenv("PORT", "5000")), threaded=True)
