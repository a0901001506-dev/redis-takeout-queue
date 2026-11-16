"""Export only the project's Redis keys as replayable RESP commands."""

from pathlib import Path

from app import ORDERS, ORDER_PREFIX, SEQUENCE, db, read_orders


def command(*args):
    parts = [str(arg).encode("utf-8") for arg in args]
    return f"*{len(parts)}\r\n".encode() + b"".join(
        f"${len(part)}\r\n".encode() + part + b"\r\n" for part in parts
    )


orders = read_orders()
sequence = db.get(SEQUENCE)
if sequence is None or not orders:
    raise SystemExit("Redis 尚無可匯出的專題資料。")
commands = [command("SET", SEQUENCE, sequence)]
for order in orders:
    number = order["number"]
    fields = [value for pair in order.items() for value in pair]
    commands.append(command("HSET", f"{ORDER_PREFIX}{number}", *fields))
commands.append(command("RPUSH", ORDERS, *(order["number"] for order in orders)))
path = Path(__file__).with_name("redis-export.resp")
path.write_bytes(b"".join(commands))
print(f"已匯出 {len(orders)} 張訂單至 {path.name}")
