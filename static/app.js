const board = document.body.dataset.view === "order";
const demoId = new URLSearchParams(location.search).get("demo");
const sync = document.querySelector("[data-sync]");
const lists = Array.from(document.querySelectorAll("[data-list]"));
const renderedOrders = new Map();
const pendingOrders = new Set();
const emptyMessages = {
  preparing: "目前沒有準備中的訂單。",
  ready: "目前沒有可取餐的訂單。",
  collected: "目前沒有已取餐的訂單。",
};

let liveConnected = false;
let stateAvailable = false;
let refreshSequence = 0;

function updateSyncLabel() {
  const active = stateAvailable && liveConnected;
  sync.dataset.active = String(active);
  sync.textContent = active ? "即時更新" : stateAvailable ? "即時連線恢復中" : "連線中";
}

function apiUrl(path) {
  const url = new URL(path, location.origin);
  if (demoId) {
    url.searchParams.set("demo", demoId);
  }
  return url;
}

async function request(path, options) {
  const response = await fetch(apiUrl(path), {cache: "no-store", ...options});
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(result.error || "暫時無法完成操作，請再試一次。");
  }
  return result;
}

function makeOrder(order) {
  const row = document.createElement("li");
  row.className = board ? "ticket" : "order-row";
  const number = document.createElement("strong");
  number.className = "order-number";
  number.textContent = order.number;
  row.append(number);
  if (board) {
    return row;
  }

  const item = document.createElement("span");
  item.className = "order-item";
  item.textContent = order.item;
  row.append(item);
  if (order.status === "collected") {
    return row;
  }

  const button = document.createElement("button");
  const preparing = order.status === "preparing";
  const label = preparing ? "叫號" : "確認取餐";
  button.className = preparing ? "button call-button" : "button collect-button";
  button.type = "button";
  button.textContent = label;
  button.setAttribute("aria-label", `${order.number} ${label}`);
  button.dataset.order = order.number;
  button.disabled = pendingOrders.has(order.number);
  button.addEventListener("click", () => changeStatus(order, preparing ? "ready" : "collected", button));
  row.append(button);
  return row;
}

function renderOrders(orders) {
  const focusedOrder = document.activeElement?.dataset.order;
  for (const list of lists) {
    const status = list.dataset.list;
    const matching = orders.filter((order) => order.status === status);
    const signature = JSON.stringify(matching);
    if (signature === renderedOrders.get(status)) {
      continue;
    }
    renderedOrders.set(status, signature);
    list.replaceChildren(...matching.map(makeOrder));
    const placeholder = document.querySelector(`[data-empty="${status}"]`);
    placeholder.textContent = emptyMessages[status];
    placeholder.hidden = matching.length > 0;
    const count = document.querySelector(`[data-count="${status}"]`);
    if (count) {
      count.textContent = `${matching.length} 筆`;
    }
  }
  if (focusedOrder && document.activeElement === document.body) {
    const focusedButton = Array.from(document.querySelectorAll("[data-order]"))
      .find((button) => button.dataset.order === focusedOrder);
    focusedButton?.focus();
  }
}

async function refreshOrders() {
  const sequence = ++refreshSequence;
  try {
    const path = board ? "/api/state?view=board" : "/api/state";
    const state = await request(path);
    if (sequence === refreshSequence) {
      renderOrders(state.orders);
      stateAvailable = true;
    }
  } catch {
    if (sequence === refreshSequence) {
      stateAvailable = false;
      sync.dataset.active = "false";
      sync.textContent = "暫時無法同步，正在重新連線";
    }
    return;
  }
  updateSyncLabel();
}

async function changeStatus(order, action, button) {
  if (pendingOrders.has(order.number)) {
    return;
  }
  const error = document.querySelector("#action-error");
  error.hidden = true;
  pendingOrders.add(order.number);
  button.disabled = true;
  try {
    await request(`/api/orders/${encodeURIComponent(order.number)}/${action}`, {method: "POST"});
  } catch (failure) {
    error.textContent = failure.message;
    error.hidden = false;
  } finally {
    await refreshOrders();
    pendingOrders.delete(order.number);
    button.disabled = false;
    const currentButton = Array.from(document.querySelectorAll("[data-order]"))
      .find((element) => element.dataset.order === order.number);
    if (currentButton) {
      currentButton.disabled = false;
    }
  }
}

function newSubmissionKey() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function setupCustomerOrder(form) {
  const menu = Array.from(form.querySelectorAll("[data-menu-item]"), (row) => ({
    id: row.dataset.menuItem,
    name: row.querySelector("strong").textContent,
    add: row.querySelector("[data-add]"),
    remove: row.querySelector("[data-remove]"),
    output: row.querySelector("[data-quantity]"),
    quantity: 0,
  }));
  const cart = form.querySelector("#cart-items");
  const empty = form.querySelector("#cart-empty");
  const submit = form.querySelector("#submit-order");
  const error = form.querySelector("#order-error");
  const receipt = document.querySelector("#ticket-receipt");
  const ticketNumber = receipt.querySelector("#ticket-number");
  const maxQuantity = Number(form.dataset.maxQuantity);
  let submitting = false;
  let submissionKey = null;

  function updateButtons() {
    for (const item of menu) {
      item.add.disabled = submitting || item.quantity >= maxQuantity;
      item.remove.disabled = submitting || item.quantity === 0;
    }
    submit.disabled = submitting || menu.every((item) => item.quantity === 0);
    submit.textContent = submitting ? "送出中…" : "送出訂單";
  }

  function renderCart() {
    const rows = [];
    for (const item of menu) {
      item.output.value = item.quantity;
      if (item.quantity > 0) {
        const line = document.createElement("li");
        line.textContent = `${item.name} × ${item.quantity}`;
        rows.push(line);
      }
    }
    cart.replaceChildren(...rows);
    empty.hidden = rows.length > 0;
    updateButtons();
  }

  function adjustQuantity(item, difference) {
    item.quantity = Math.max(0, Math.min(maxQuantity, item.quantity + difference));
    submissionKey = null;
    receipt.hidden = true;
    error.hidden = true;
    renderCart();
  }

  for (const item of menu) {
    item.add.addEventListener("click", () => adjustQuantity(item, 1));
    item.remove.addEventListener("click", () => adjustQuantity(item, -1));
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (submit.disabled) {
      return;
    }
    const items = menu.filter((item) => item.quantity > 0)
      .map(({id, quantity}) => ({id, quantity}));
    submissionKey ??= newSubmissionKey();
    submitting = true;
    error.hidden = true;
    updateButtons();
    try {
      const data = await request("/api/orders", {
        method: "POST",
        headers: {"Content-Type": "application/json", "Idempotency-Key": submissionKey},
        body: JSON.stringify({items}),
      });
      ticketNumber.textContent = data.order.number;
      receipt.hidden = false;
      receipt.scrollIntoView({block: "nearest"});
      for (const item of menu) {
        item.quantity = 0;
      }
      submissionKey = null;
      renderCart();
    } catch (failure) {
      error.textContent = failure.message;
      error.hidden = false;
    } finally {
      submitting = false;
      updateButtons();
    }
  });
}

const customerForm = document.querySelector("#customer-order-form");
if (customerForm) {
  setupCustomerOrder(customerForm);
}
if (sync) {
  if ("EventSource" in window) {
    const events = new EventSource(apiUrl("/api/events"));
    events.addEventListener("open", () => {
      liveConnected = true;
      refreshOrders();
    });
    events.addEventListener("message", refreshOrders);
    events.addEventListener("error", () => {
      liveConnected = false;
      updateSyncLabel();
    });
  }
  refreshOrders();
  setInterval(() => {
    if (!liveConnected || !stateAvailable) {
      refreshOrders();
    }
  }, 4000);
}
