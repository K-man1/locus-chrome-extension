function send(msg) {
  return new Promise((res) => chrome.runtime.sendMessage(msg, res));
}

async function getAll() {
  return await send({ type: "getState" });
}

async function save(patch) {
  await chrome.storage.local.set(patch);
}

function escapeHtml(s) {
  return String(s || "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}

function tag(text, onRemove) {
  const span = document.createElement("span");
  span.className = "tag";
  span.textContent = text;
  const x = document.createElement("span");
  x.className = "x";
  x.textContent = "×";
  x.title = "Remove";
  x.addEventListener("click", onRemove);
  span.appendChild(x);
  return span;
}

async function render() {
  const state = await getAll();

  // Activities
  const acts = document.getElementById("activities");
  acts.innerHTML = "";
  const names = Object.keys(state.activities || {});
  if (names.length === 0) {
    acts.innerHTML = `<div class="muted tiny">No activities yet — add one below.</div>`;
  }
  for (const name of names) {
    const a = state.activities[name];
    const card = document.createElement("div");
    card.className = "card";

    const head = document.createElement("div");
    head.className = "row between";
    const title = document.createElement("input");
    title.type = "text"; title.value = name;
    title.style.flex = "1"; title.style.fontWeight = "600"; title.style.fontSize = "15px";
    title.addEventListener("change", async () => {
      const newName = title.value.trim();
      if (!newName || newName === name) { title.value = name; return; }
      if (state.activities[newName]) { alert("That name is taken."); title.value = name; return; }
      const next = { ...state.activities };
      next[newName] = next[name];
      delete next[name];
      await save({ activities: next });
      // If the active session points at the old name, rename it.
      if (state.session?.activity === name) {
        await save({ session: { ...state.session, activity: newName } });
      }
      render();
    });

    const del = document.createElement("button");
    del.className = "danger small";
    del.textContent = "Delete";
    del.addEventListener("click", async () => {
      if (!confirm(`Delete "${name}"?`)) return;
      const next = { ...state.activities };
      delete next[name];
      const patch = { activities: next };
      if (state.session?.activity === name) patch.session = null;
      await save(patch);
      render();
    });

    head.appendChild(title);
    head.appendChild(del);
    card.appendChild(head);

    const sub = document.createElement("div");
    sub.className = "muted tiny";
    sub.textContent = "Allowed domains";
    sub.style.marginTop = "10px";
    card.appendChild(sub);

    const tags = document.createElement("div");
    tags.className = "domains";
    for (const d of (a.allowDomains || [])) {
      tags.appendChild(tag(d, async () => {
        const next = { ...state.activities };
        next[name] = { ...a, allowDomains: a.allowDomains.filter((x) => x !== d) };
        await save({ activities: next });
        render();
      }));
    }
    card.appendChild(tags);

    const add = document.createElement("div");
    add.className = "add-domain";
    const input = document.createElement("input");
    input.type = "text"; input.placeholder = "khanacademy.org";
    const btn = document.createElement("button"); btn.textContent = "Add";
    const doAdd = async () => {
      const v = input.value.trim().replace(/^https?:\/\//i, "").replace(/\/.*$/, "").toLowerCase();
      if (!v) return;
      if ((a.allowDomains || []).includes(v)) { input.value = ""; return; }
      const next = { ...state.activities };
      next[name] = { ...a, allowDomains: [...(a.allowDomains || []), v] };
      await save({ activities: next });
      render();
    };
    btn.addEventListener("click", doAdd);
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") doAdd(); });
    add.appendChild(input); add.appendChild(btn);
    card.appendChild(add);

    acts.appendChild(card);
  }

  // Always allowed
  const aaTags = document.getElementById("alwaysAllowedTags");
  aaTags.innerHTML = "";
  for (const d of (state.alwaysAllowed || [])) {
    aaTags.appendChild(tag(d, async () => {
      await save({ alwaysAllowed: state.alwaysAllowed.filter((x) => x !== d) });
      render();
    }));
  }

  // Override code
  document.getElementById("overrideCode").value = state.overrideCode || "";
  document.getElementById("tempAllowMins").value = String(state.tempAllowMins ?? 10);
}

document.getElementById("addActivity").addEventListener("click", async () => {
  const inp = document.getElementById("newActivityName");
  const v = inp.value.trim();
  if (!v) return;
  const state = await getAll();
  if (state.activities[v]) { alert("Already exists."); return; }
  const next = { ...state.activities, [v]: { allowDomains: [] } };
  await save({ activities: next });
  inp.value = "";
  render();
});

document.getElementById("addAlwaysAllowed").addEventListener("click", async () => {
  const inp = document.getElementById("newAlwaysAllowed");
  const v = inp.value.trim().replace(/^https?:\/\//i, "").replace(/\/.*$/, "").toLowerCase();
  if (!v) return;
  const state = await getAll();
  if ((state.alwaysAllowed || []).includes(v)) { inp.value = ""; return; }
  await save({ alwaysAllowed: [...(state.alwaysAllowed || []), v] });
  inp.value = "";
  render();
});

document.getElementById("saveOverride").addEventListener("click", async () => {
  const v = document.getElementById("overrideCode").value;
  await save({ overrideCode: v });
  const s = document.getElementById("overrideStatus");
  s.textContent = "Saved."; setTimeout(() => s.textContent = "", 1500);
});

document.getElementById("saveTemp").addEventListener("click", async () => {
  const v = parseInt(document.getElementById("tempAllowMins").value, 10);
  if (!Number.isFinite(v) || v <= 0) { alert("Must be a positive number."); return; }
  await save({ tempAllowMins: v });
  const s = document.getElementById("tempStatus");
  s.textContent = "Saved."; setTimeout(() => s.textContent = "", 1500);
});

render();
