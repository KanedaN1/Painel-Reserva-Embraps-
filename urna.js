import { DEFAULT_FIREBASE_CONFIG, GOOGLE_SHEET_ID } from "./firebase-config.js";

const STORAGE_KEYS = {
  RECORDS: "embraps_reserva_records_v1",
  COLABORADORES_CACHE: "embraps_colaboradores_cache_v1",
  FIREBASE_CONFIG: "embraps_firebase_config_v1"
};

let colaboradoresByRe = new Map();
let registrosReserva = [];
let firestoreDb = null;
let firebaseFunctions = null;
let firebaseConnected = false;
let confirmTimer = null;

function pad2(n) {
  return String(n).padStart(2, "0");
}

function getTodayIso(dateObj = new Date()) {
  return `${dateObj.getFullYear()}-${pad2(dateObj.getMonth() + 1)}-${pad2(dateObj.getDate())}`;
}

function formatDataCurta(isoDateStr) {
  if (!isoDateStr) return "--/--";
  const parts = isoDateStr.split("-");
  return parts.length === 3 ? `${parts[2]}/${parts[1]}` : isoDateStr;
}

function formatDataCompleta(isoDateStr) {
  if (!isoDateStr) return "--/--/----";
  const parts = isoDateStr.split("-");
  return parts.length === 3 ? `${parts[2]}/${parts[1]}/${parts[0]}` : isoDateStr;
}

function formatHora(dateObj = new Date()) {
  return `${pad2(dateObj.getHours())}:${pad2(dateObj.getMinutes())}:${pad2(dateObj.getSeconds())}`;
}

function formatDurationHMS(totalSeconds) {
  const sec = Math.max(0, Math.floor(Number(totalSeconds) || 0));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return `${pad2(h)}:${pad2(m)}:${pad2(s)}`;
}

function normalizeRe(reValue) {
  const clean = String(reValue || "").trim();
  if (!clean) return "";
  if (/^\d+$/.test(clean)) return String(parseInt(clean, 10));
  return clean.toUpperCase();
}

function escapeHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function parseCsvLine(line) {
  const result = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === "," && !inQuotes) {
      result.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  result.push(current.trim());
  return result;
}

function indexColaboradores(list) {
  colaboradoresByRe.clear();
  for (const colab of list) {
    const norm = normalizeRe(colab.re);
    if (norm) colaboradoresByRe.set(norm, colab);
    colaboradoresByRe.set(String(colab.re).trim(), colab);
  }
}

async function syncGoogleSheets() {
  try {
    const cached = localStorage.getItem(STORAGE_KEYS.COLABORADORES_CACHE);
    if (cached) {
      const parsed = JSON.parse(cached);
      if (Array.isArray(parsed)) indexColaboradores(parsed);
    }
  } catch (_e) {
    // Continua
  }

  const urls = [
    `https://docs.google.com/spreadsheets/d/${GOOGLE_SHEET_ID}/gviz/tq?tqx=out:csv&t=${Date.now()}`,
    `https://docs.google.com/spreadsheets/d/${GOOGLE_SHEET_ID}/export?format=csv`
  ];

  for (const url of urls) {
    try {
      const resp = await fetch(url, { cache: "no-store" });
      if (resp.ok) {
        const text = await resp.text();
        if (text && text.includes(",") && !text.trim().startsWith("<!DOCTYPE")) {
          const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
          const parsed = [];
          for (let i = 0; i < lines.length; i++) {
            const cols = parseCsvLine(lines[i]);
            if (cols.length < 2) continue;
            const reRaw = cols[0].replace(/^"|"$/g, "").trim();
            const nomeRaw = (cols[1] || "").replace(/^"|"$/g, "").trim();
            const funcaoRaw = (cols[2] || "").replace(/^"|"$/g, "").trim();
            if (i === 0 && reRaw.toLowerCase() === "re") continue;
            if (!reRaw || !nomeRaw) continue;
            parsed.push({ re: reRaw, nome: nomeRaw, funcao: funcaoRaw || "NÃO INFORMADO" });
          }
          if (parsed.length > 0) {
            indexColaboradores(parsed);
            localStorage.setItem(STORAGE_KEYS.COLABORADORES_CACHE, JSON.stringify(parsed));
            updateUrnaPreview();
          }
          break;
        }
      }
    } catch (_err) {
      // Tenta próximo
    }
  }
}

function getActiveFirebaseConfig() {
  try {
    const saved = localStorage.getItem(STORAGE_KEYS.FIREBASE_CONFIG);
    if (saved) {
      const parsed = JSON.parse(saved);
      if (parsed && parsed.projectId && parsed.apiKey) return parsed;
    }
  } catch (_e) {
    // Continua
  }
  if (DEFAULT_FIREBASE_CONFIG && DEFAULT_FIREBASE_CONFIG.projectId && DEFAULT_FIREBASE_CONFIG.apiKey) {
    return DEFAULT_FIREBASE_CONFIG;
  }
  return null;
}

async function initFirebase() {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.RECORDS);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) registrosReserva = parsed;
    }
  } catch (_e) {
    registrosReserva = [];
  }

  const config = getActiveFirebaseConfig();
  if (!config) return;

  try {
    const appModule = await import("https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js");
    const firestoreModule = await import("https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js");

    firebaseFunctions = firestoreModule;
    const apps = appModule.getApps();
    const app = apps.length > 0 ? appModule.getApp() : appModule.initializeApp(config);
    firestoreDb = firestoreModule.getFirestore(app);

    const colRef = firestoreModule.collection(firestoreDb, "registros_reserva");
    firestoreModule.onSnapshot(colRef, (snapshot) => {
      const docs = [];
      snapshot.forEach((docSnap) => docs.push({ id: docSnap.id, ...docSnap.data() }));
      docs.sort((a, b) => (b.chegadaTs || 0) - (a.chegadaTs || 0));
      registrosReserva = docs;
      localStorage.setItem(STORAGE_KEYS.RECORDS, JSON.stringify(registrosReserva));
      firebaseConnected = true;
      updateUrnaPreview();
    });
  } catch (err) {
    console.error("Erro Firebase no modo Urna:", err);
  }
}

async function persistRecord(record) {
  const idx = registrosReserva.findIndex((r) => r.id === record.id);
  if (idx >= 0) registrosReserva[idx] = record;
  else registrosReserva.unshift(record);

  try {
    localStorage.setItem(STORAGE_KEYS.RECORDS, JSON.stringify(registrosReserva));
  } catch (_e) {
    // Ignora
  }

  if (firebaseConnected && firestoreDb && firebaseFunctions) {
    try {
      const docRef = firebaseFunctions.doc(firestoreDb, "registros_reserva", record.id);
      await firebaseFunctions.setDoc(docRef, record, { merge: true });
    } catch (err) {
      console.error("Erro ao gravar no Firestore:", err);
    }
  }
}

function findOpenRecordForRe(rawRe) {
  const norm = normalizeRe(rawRe);
  if (!norm) return null;
  const openMatches = registrosReserva.filter(
    (r) => !r.saidaTs && normalizeRe(r.reEntrada) === norm
  );
  return openMatches.length > 0 ? openMatches[openMatches.length - 1] : null;
}

function updateUrnaPreview() {
  const inputEl = document.getElementById("inputUrnaRe");
  const cardEl = document.getElementById("urnaColabCard");
  const rawRe = inputEl.value.trim();

  if (!rawRe) {
    cardEl.className = "urna-colab-card";
    cardEl.innerHTML = `<div class="urna-Idle-msg">Aguardando digitação da matrícula (RE)...</div>`;
    return;
  }

  const norm = normalizeRe(rawRe);
  const colab = colaboradoresByRe.get(norm) || colaboradoresByRe.get(rawRe);
  const openRec = findOpenRecordForRe(rawRe);

  if (openRec) {
    const sec = Math.max(0, Math.floor((Date.now() - openRec.chegadaTs) / 1000));
    cardEl.className = "urna-colab-card state-exit";
    cardEl.innerHTML = `
      <div class="urna-action-tag tag-exit">PRÓXIMA AÇÃO: REGISTRAR SAÍDA DA RESERVA</div>
      <div class="urna-colab-name">${escapeHtml(openRec.nome)}</div>
      <div class="urna-colab-role">FUNÇÃO: ${escapeHtml(openRec.funcao)} • RE: ${escapeHtml(openRec.reEntrada)}</div>
      <div class="urna-colab-meta">Entrada às <strong>${escapeHtml(openRec.chegadaHora)}</strong> • Permanência atual: <strong>${formatDurationHMS(sec)}</strong></div>
    `;
  } else if (colab) {
    cardEl.className = "urna-colab-card state-entry";
    cardEl.innerHTML = `
      <div class="urna-action-tag tag-entry">PRÓXIMA AÇÃO: REGISTRAR ENTRADA NA RESERVA</div>
      <div class="urna-colab-name">${escapeHtml(colab.nome)}</div>
      <div class="urna-colab-role">FUNÇÃO: ${escapeHtml(colab.funcao)} • RE: ${escapeHtml(colab.re)}</div>
      <div class="urna-colab-meta">Pressione <strong>ENTER</strong> para confirmar a chegada</div>
    `;
  } else {
    cardEl.className = "urna-colab-card state-unknown";
    cardEl.innerHTML = `
      <div class="urna-action-tag tag-entry">PRÓXIMA AÇÃO: REGISTRAR ENTRADA (RE ${escapeHtml(rawRe)})</div>
      <div class="urna-colab-name">MATRÍCULA RE ${escapeHtml(rawRe)}</div>
      <div class="urna-colab-role">Colaborador ainda não listado na planilha base</div>
      <div class="urna-colab-meta">Pressione <strong>ENTER</strong> para registrar entrada com o RE ${escapeHtml(rawRe)}</div>
    `;
  }
}

function showUrnaConfirmation(type, nome, funcao, detailText) {
  const overlay = document.getElementById("urnaConfirmOverlay");
  const badge = document.getElementById("urnaConfirmBadge");
  const nameEl = document.getElementById("urnaConfirmName");
  const roleEl = document.getElementById("urnaConfirmRole");
  const timeEl = document.getElementById("urnaConfirmTime");

  if (confirmTimer) clearTimeout(confirmTimer);

  badge.textContent = type === "saida" ? "SAÍDA REGISTRADA COM SUCESSO" : "ENTRADA REGISTRADA COM SUCESSO";
  badge.className = `urna-confirm-badge ${type === "saida" ? "badge-saida" : "badge-entrada"}`;
  nameEl.textContent = nome;
  roleEl.textContent = funcao;
  timeEl.textContent = detailText;

  overlay.hidden = false;
  confirmTimer = setTimeout(() => {
    overlay.hidden = true;
  }, 3200);
}

async function handleUrnaSubmit(event) {
  if (event) event.preventDefault();
  const inputEl = document.getElementById("inputUrnaRe");
  const rawRe = inputEl.value.trim();
  if (!rawRe) {
    inputEl.focus();
    return;
  }

  const norm = normalizeRe(rawRe);
  const colab = colaboradoresByRe.get(norm) || colaboradoresByRe.get(rawRe);
  const openRec = findOpenRecordForRe(rawRe);
  const now = new Date();

  if (openRec) {
    // Registra SAÍDA
    const saidaTs = now.getTime();
    const duracaoSegundos = Math.max(1, Math.floor((saidaTs - openRec.chegadaTs) / 1000));
    const atualizado = {
      ...openRec,
      saidaTs,
      saidaHora: formatHora(now),
      reSaida: rawRe,
      duracaoSegundos
    };
    await persistRecord(atualizado);
    showUrnaConfirmation(
      "saida",
      atualizado.nome,
      `RE ${atualizado.reSaida} • ${atualizado.funcao}`,
      `Saída: ${atualizado.saidaHora} | Tempo na Reserva: ${formatDurationHMS(duracaoSegundos)}`
    );
  } else {
    // Registra ENTRADA
    const nomeFinal = colab ? colab.nome.toUpperCase() : `COLABORADOR RE ${rawRe}`;
    const funcaoFinal = colab ? colab.funcao.toUpperCase() : "NÃO INFORMADO";
    const novoRegistro = {
      id: `res_${now.getTime()}_${Math.random().toString(36).substring(2, 7)}`,
      dataIso: getTodayIso(now),
      dataDisplay: formatDataCurta(getTodayIso(now)),
      reEntrada: rawRe,
      nome: nomeFinal,
      funcao: funcaoFinal,
      chegadaTs: now.getTime(),
      chegadaHora: formatHora(now),
      saidaTs: null,
      saidaHora: "",
      reSaida: "",
      transporte: "",
      motivo: "Reserva",
      diaTrabalho: "Sim",
      supervisor: "",
      posto: "",
      observacao: "",
      duracaoSegundos: 0
    };
    await persistRecord(novoRegistro);
    showUrnaConfirmation(
      "entrada",
      novoRegistro.nome,
      `RE ${novoRegistro.reEntrada} • ${novoRegistro.funcao}`,
      `Horário de Chegada: ${novoRegistro.chegadaHora}`
    );
  }

  inputEl.value = "";
  updateUrnaPreview();
  inputEl.focus();
}

function setupUrnaEvents() {
  const inputEl = document.getElementById("inputUrnaRe");
  const formEl = document.getElementById("formUrna");

  inputEl.addEventListener("input", () => {
    const overlay = document.getElementById("urnaConfirmOverlay");
    if (overlay && !overlay.hidden && inputEl.value.trim().length > 0) {
      overlay.hidden = true;
    }
    updateUrnaPreview();
  });

  formEl.addEventListener("submit", handleUrnaSubmit);

  document.querySelectorAll(".urna-key").forEach((btn) => {
    btn.addEventListener("click", () => {
      const digit = btn.dataset.digit;
      inputEl.value += digit;
      inputEl.dispatchEvent(new Event("input"));
      inputEl.focus();
    });
  });

  document.getElementById("btnUrnaCorrige").addEventListener("click", () => {
    inputEl.value = "";
    inputEl.dispatchEvent(new Event("input"));
    inputEl.focus();
  });

  document.getElementById("btnUrnaConfirma").addEventListener("click", () => {
    handleUrnaSubmit();
  });

  // Mantém o foco sempre no input do RE para uso com teclado numérico USB
  document.addEventListener("click", (e) => {
    if (!e.target.closest("button") && !e.target.closest("input")) {
      inputEl.focus();
    }
  });
}

function startClock() {
  const tick = () => {
    const now = new Date();
    const dateEl = document.getElementById("liveDate");
    const timeEl = document.getElementById("liveTime");
    if (dateEl) dateEl.textContent = formatDataCompleta(getTodayIso(now));
    if (timeEl) timeEl.textContent = formatHora(now);
  };
  tick();
  setInterval(tick, 1000);
}

async function initUrna() {
  setupUrnaEvents();
  startClock();
  await Promise.all([syncGoogleSheets(), initFirebase()]);
}

initUrna();
