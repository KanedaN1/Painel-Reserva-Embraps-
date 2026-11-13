import { DEFAULT_FIREBASE_CONFIG, GOOGLE_SHEET_ID } from "./firebase-config.js";

// ============================================================================
// ESTADO GLOBAL DA APLICAÇÃO
// ============================================================================
const STORAGE_KEYS = {
  RECORDS: "embraps_reserva_records_v1",
  COLABORADORES_CACHE: "embraps_colaboradores_cache_v1",
  FIREBASE_CONFIG: "embraps_firebase_config_v1",
  SGPQ_AUTH: "embraps_sgpq_auth_session"
};

let colaboradoresList = [];
let colaboradoresByRe = new Map();
let registrosReserva = [];
let isSgpqAuthenticated = sessionStorage.getItem(STORAGE_KEYS.SGPQ_AUTH) === "true";

// Estado Firebase
let firestoreDb = null;
let firestoreUnsubscribe = null;
let firebaseConnected = false;
let firebaseFunctions = null;

// ============================================================================
// UTILITÁRIOS DE DATA E HORA
// ============================================================================
function pad2(n) {
  return String(n).padStart(2, "0");
}

function getTodayIso(dateObj = new Date()) {
  const y = dateObj.getFullYear();
  const m = pad2(dateObj.getMonth() + 1);
  const d = pad2(dateObj.getDate());
  return `${y}-${m}-${d}`;
}

function formatDataCurta(isoDateStr) {
  if (!isoDateStr) return "--/--";
  const parts = isoDateStr.split("-");
  if (parts.length !== 3) return isoDateStr;
  return `${parts[2]}/${parts[1]}`;
}

function formatDataCompleta(isoDateStr) {
  if (!isoDateStr) return "--/--/----";
  const parts = isoDateStr.split("-");
  if (parts.length !== 3) return isoDateStr;
  return `${parts[2]}/${parts[1]}/${parts[0]}`;
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

function formatHoursHuman(totalSeconds) {
  const sec = Math.max(0, Math.floor(Number(totalSeconds) || 0));
  const hoursDecimal = (sec / 3600).toFixed(2).replace(".", ",");
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return `${h}h ${pad2(m)}min (${hoursDecimal}h)`;
}

function normalizeRe(reValue) {
  const clean = String(reValue || "").trim();
  if (!clean) return "";
  // Remove zeros à esquerda caso seja puramente numérico para parear com a planilha
  if (/^\d+$/.test(clean)) {
    return String(parseInt(clean, 10));
  }
  return clean.toUpperCase();
}

function showToast(message) {
  const container = document.getElementById("toastContainer");
  if (!container) return;
  const toast = document.createElement("div");
  toast.className = "toast-msg";
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => {
    toast.remove();
  }, 3600);
}

// ============================================================================
// SINCRONIZAÇÃO COM GOOGLE SHEETS (COLABORADORES: RE, NOME, FUNÇÃO)
// ============================================================================
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
  colaboradoresList = list;
  colaboradoresByRe.clear();
  for (const colab of list) {
    const norm = normalizeRe(colab.re);
    if (norm) {
      colaboradoresByRe.set(norm, colab);
    }
    colaboradoresByRe.set(String(colab.re).trim(), colab);
  }
}

async function syncGoogleSheets(showNotification = false) {
  const dot = document.getElementById("sheetsStatusDot");
  const label = document.getElementById("sheetsCountLabel");
  if (label) label.textContent = "Sincronizando...";

  const urlsToTry = [
    `https://docs.google.com/spreadsheets/d/${GOOGLE_SHEET_ID}/gviz/tq?tqx=out:csv&t=${Date.now()}`,
    `https://docs.google.com/spreadsheets/d/${GOOGLE_SHEET_ID}/export?format=csv`
  ];

  let csvText = null;
  for (const url of urlsToTry) {
    try {
      const resp = await fetch(url, { cache: "no-store" });
      if (resp.ok) {
        const text = await resp.text();
        if (text && text.includes(",") && !text.trim().startsWith("<!DOCTYPE")) {
          csvText = text;
          break;
        }
      }
    } catch (_err) {
      // Tenta o próximo endpoint
    }
  }

  if (!csvText) {
    if (colaboradoresList.length > 0) {
      if (dot) dot.className = "status-dot local";
      if (label) label.textContent = `${colaboradoresList.length.toLocaleString("pt-BR")} REs (Cache)`;
    } else {
      if (dot) dot.className = "status-dot error";
      if (label) label.textContent = "Falha na leitura";
    }
    return;
  }

  const lines = csvText.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const parsed = [];

  for (let i = 0; i < lines.length; i++) {
    const cols = parseCsvLine(lines[i]);
    if (cols.length < 2) continue;
    const reRaw = cols[0].replace(/^"|"$/g, "").trim();
    const nomeRaw = (cols[1] || "").replace(/^"|"$/g, "").trim();
    const funcaoRaw = (cols[2] || "").replace(/^"|"$/g, "").trim();

    if (i === 0 && reRaw.toLowerCase() === "re") continue;
    if (!reRaw || !nomeRaw) continue;

    parsed.push({
      re: reRaw,
      nome: nomeRaw,
      funcao: funcaoRaw || "NÃO INFORMADO"
    });
  }

  if (parsed.length > 0) {
    indexColaboradores(parsed);
    try {
      localStorage.setItem(STORAGE_KEYS.COLABORADORES_CACHE, JSON.stringify(parsed));
    } catch (_e) {
      // Ignora quota de storage
    }

    if (dot) dot.className = "status-dot online";
    if (label) label.textContent = `${parsed.length.toLocaleString("pt-BR")} colaboradores`;
    renderBaseColaboradoresTable();
    populateCargoFilterOptions();

    if (showNotification) {
      showToast(`Planilha sincronizada: ${parsed.length.toLocaleString("pt-BR")} colaboradores ativos.`);
    }
  }
}

function loadCachedColaboradores() {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.COLABORADORES_CACHE);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) {
        indexColaboradores(parsed);
        const dot = document.getElementById("sheetsStatusDot");
        const label = document.getElementById("sheetsCountLabel");
        if (dot) dot.className = "status-dot online";
        if (label) label.textContent = `${parsed.length.toLocaleString("pt-BR")} colaboradores`;
      }
    }
  } catch (_e) {
    // Ignora erro de parse
  }
}

// ============================================================================
// PERSISTÊNCIA DE DADOS (FIREBASE CLOUD FIRESTORE + LOCAL FALLBACK)
// ============================================================================
function getActiveFirebaseConfig() {
  try {
    const saved = localStorage.getItem(STORAGE_KEYS.FIREBASE_CONFIG);
    if (saved) {
      const parsed = JSON.parse(saved);
      if (parsed && parsed.projectId && parsed.apiKey) {
        return parsed;
      }
    }
  } catch (_e) {
    // Continua para default
  }
  if (DEFAULT_FIREBASE_CONFIG && DEFAULT_FIREBASE_CONFIG.projectId && DEFAULT_FIREBASE_CONFIG.apiKey) {
    return DEFAULT_FIREBASE_CONFIG;
  }
  return null;
}

function loadLocalRecords() {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.RECORDS);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        registrosReserva = parsed;
      }
    }
  } catch (_e) {
    registrosReserva = [];
  }
}

function saveLocalRecords() {
  try {
    localStorage.setItem(STORAGE_KEYS.RECORDS, JSON.stringify(registrosReserva));
  } catch (_e) {
    // Ignora erro
  }
}

async function initFirebaseConnection() {
  const dot = document.getElementById("dbStatusDot");
  const label = document.getElementById("dbStatusLabel");
  const banner = document.getElementById("firebaseModalStatusBanner");

  const config = getActiveFirebaseConfig();
  if (!config) {
    firebaseConnected = false;
    if (dot) dot.className = "status-dot local";
    if (label) label.textContent = "Modo Local (Configurar Firebase)";
    if (banner) {
      banner.textContent = "Status atual: Armazenamento Local Ativo. Cole as chaves do seu projeto Firebase abaixo para sincronizar em nuvem.";
    }
    return;
  }

  try {
    if (label) label.textContent = "Conectando Firebase...";
    const appModule = await import("https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js");
    const firestoreModule = await import("https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js");

    firebaseFunctions = firestoreModule;
    const apps = appModule.getApps();
    const app = apps.length > 0 ? appModule.getApp() : appModule.initializeApp(config);
    firestoreDb = firestoreModule.getFirestore(app);

    if (firestoreUnsubscribe) {
      firestoreUnsubscribe();
    }

    const colRef = firestoreModule.collection(firestoreDb, "registros_reserva");
    firestoreUnsubscribe = firestoreModule.onSnapshot(
      colRef,
      (snapshot) => {
        const docs = [];
        snapshot.forEach((docSnap) => {
          docs.push({ id: docSnap.id, ...docSnap.data() });
        });
        docs.sort((a, b) => (b.chegadaTs || 0) - (a.chegadaTs || 0));
        registrosReserva = docs;
        saveLocalRecords();
        firebaseConnected = true;

        if (dot) dot.className = "status-dot online";
        if (label) label.textContent = `Firebase Online (${config.projectId})`;
        if (banner) {
          banner.textContent = `Conectado em tempo real ao projeto Firebase: ${config.projectId} (${docs.length} registros na nuvem).`;
        }

        renderAll();
      },
      (error) => {
        console.error("Erro no listener Firestore:", error);
        firebaseConnected = false;
        if (dot) dot.className = "status-dot error";
        if (label) label.textContent = "Erro de Permissão Firebase";
        if (banner) {
          banner.textContent = `Atenção: Não foi possível ler a coleção no Firebase (${error.message}). Verifique as regras do Firestore.`;
        }
      }
    );
  } catch (err) {
    console.error("Falha ao inicializar Firebase:", err);
    firebaseConnected = false;
    if (dot) dot.className = "status-dot error";
    if (label) label.textContent = "Erro na conexão Firebase";
  }
}

async function persistRecord(record) {
  // Atualiza na lista em memória + LocalStorage imediatamente
  const idx = registrosReserva.findIndex((r) => r.id === record.id);
  if (idx >= 0) {
    registrosReserva[idx] = record;
  } else {
    registrosReserva.unshift(record);
  }
  saveLocalRecords();
  renderAll();

  // Se o Firebase estiver conectado, grava no Firestore
  if (firebaseConnected && firestoreDb && firebaseFunctions) {
    try {
      const docRef = firebaseFunctions.doc(firestoreDb, "registros_reserva", record.id);
      await firebaseFunctions.setDoc(docRef, record, { merge: true });
    } catch (err) {
      console.error("Erro ao salvar no Firebase:", err);
      showToast("Salvo localmente. Falha ao sincronizar com Firebase.");
    }
  }
}

async function deleteRecordById(recordId) {
  registrosReserva = registrosReserva.filter((r) => r.id !== recordId);
  saveLocalRecords();
  renderAll();

  if (firebaseConnected && firestoreDb && firebaseFunctions) {
    try {
      const docRef = firebaseFunctions.doc(firestoreDb, "registros_reserva", recordId);
      await firebaseFunctions.deleteDoc(docRef);
    } catch (err) {
      console.error("Erro ao excluir do Firebase:", err);
    }
  }
}

// ============================================================================
// LÓGICA DE ENTRADA E SAÍDA DA RESERVA
// ============================================================================
function lookupColaboradorByRe(reInput) {
  const norm = normalizeRe(reInput);
  if (!norm) return null;
  return colaboradoresByRe.get(norm) || colaboradoresByRe.get(String(reInput).trim()) || null;
}

function handleReEntradaTyping() {
  const reInputEl = document.getElementById("inputReEntrada");
  const nomeInputEl = document.getElementById("inputNomeEntrada");
  const funcaoInputEl = document.getElementById("inputFuncaoEntrada");
  const feedbackEl = document.getElementById("entryLookupFeedback");

  const rawRe = reInputEl.value.trim();
  if (!rawRe) {
    nomeInputEl.value = "";
    funcaoInputEl.value = "";
    nomeInputEl.readOnly = true;
    funcaoInputEl.readOnly = true;
    feedbackEl.className = "entry-lookup-feedback";
    feedbackEl.textContent = "Digite a matrícula (RE) para buscar automaticamente na base Google Sheets.";
    return;
  }

  const found = lookupColaboradorByRe(rawRe);
  if (found) {
    nomeInputEl.value = found.nome;
    funcaoInputEl.value = found.funcao;
    nomeInputEl.readOnly = true;
    funcaoInputEl.readOnly = true;

    const jaAberto = registrosReserva.find(
      (r) => !r.saidaTs && normalizeRe(r.reEntrada) === normalizeRe(rawRe)
    );

    feedbackEl.className = "entry-lookup-feedback found";
    if (jaAberto) {
      feedbackEl.textContent = `Colaborador localizado: ${found.nome} (${found.funcao}) — Atenção: já possui entrada em aberto às ${jaAberto.chegadaHora}.`;
    } else {
      feedbackEl.textContent = `Colaborador localizado na base Google Sheets: ${found.nome} — Função: ${found.funcao}`;
    }
  } else {
    nomeInputEl.readOnly = false;
    funcaoInputEl.readOnly = false;
    if (nomeInputEl.dataset.autoFilled === "true") {
      nomeInputEl.value = "";
      funcaoInputEl.value = "";
    }
    nomeInputEl.dataset.autoFilled = "false";
    feedbackEl.className = "entry-lookup-feedback manual";
    feedbackEl.textContent = `RE ${rawRe} não localizado na planilha. Se for uma admissão recente, preencha Nome e Função manualmente ou sincronize a planilha.`;
  }

  if (found) {
    nomeInputEl.dataset.autoFilled = "true";
  }
}

async function handleRegistrarEntrada(event) {
  event.preventDefault();

  const reInputEl = document.getElementById("inputReEntrada");
  const nomeInputEl = document.getElementById("inputNomeEntrada");
  const funcaoInputEl = document.getElementById("inputFuncaoEntrada");
  const supInputEl = document.getElementById("inputSupervisorEntrada");
  const postoInputEl = document.getElementById("inputPostoEntrada");
  const obsInputEl = document.getElementById("inputObsEntrada");

  const reVal = reInputEl.value.trim();
  if (!reVal) {
    reInputEl.focus();
    return;
  }

  const found = lookupColaboradorByRe(reVal);
  const nomeFinal = (found ? found.nome : nomeInputEl.value.trim()).toUpperCase();
  const funcaoFinal = (found ? found.funcao : funcaoInputEl.value.trim()).toUpperCase() || "NÃO INFORMADO";

  if (!nomeFinal) {
    showToast("Informe o nome do colaborador ou verifique se o RE está correto.");
    nomeInputEl.focus();
    return;
  }

  const now = new Date();
  const novoRegistro = {
    id: `res_${now.getTime()}_${Math.random().toString(36).substring(2, 7)}`,
    dataIso: getTodayIso(now),
    dataDisplay: formatDataCurta(getTodayIso(now)),
    reEntrada: reVal,
    nome: nomeFinal,
    funcao: funcaoFinal,
    chegadaTs: now.getTime(),
    chegadaHora: formatHora(now),
    saidaTs: null,
    saidaHora: "",
    reSaida: "",
    supervisor: supInputEl.value.trim().toUpperCase(),
    posto: postoInputEl.value.trim().toUpperCase(),
    observacao: obsInputEl.value.trim(),
    duracaoSegundos: 0
  };

  await persistRecord(novoRegistro);

  // Limpa campos e devolve foco para o RE de entrada
  reInputEl.value = "";
  nomeInputEl.value = "";
  funcaoInputEl.value = "";
  supInputEl.value = "";
  postoInputEl.value = "";
  obsInputEl.value = "";
  handleReEntradaTyping();
  reInputEl.focus();

  showToast(`Entrada registrada: RE ${novoRegistro.reEntrada} — ${novoRegistro.nome} às ${novoRegistro.chegadaHora}`);
}

function handleReSaidaRapidaTyping() {
  const inputEl = document.getElementById("inputReSaidaRapida");
  const previewBox = document.getElementById("exitPreviewBox");
  const rawRe = inputEl.value.trim();

  if (!rawRe) {
    previewBox.className = "exit-preview-box";
    previewBox.innerHTML = `<span class="exit-preview-placeholder">Você pode dar baixa digitando o <strong>RE - SAÍDA</strong> aqui ou diretamente na coluna <strong>RE - SAÍDA</strong> da tabela abaixo.</span>`;
    return;
  }

  const norm = normalizeRe(rawRe);
  // Procura registro em aberto para este RE
  const openRecord = registrosReserva.find(
    (r) => !r.saidaTs && normalizeRe(r.reEntrada) === norm
  );

  if (openRecord) {
    const elapsedSec = Math.max(0, Math.floor((Date.now() - openRecord.chegadaTs) / 1000));
    previewBox.className = "exit-preview-box active-match";
    previewBox.innerHTML = `
      <div><strong>Na Reserva:</strong> ${openRecord.nome} (${openRecord.funcao})</div>
      <div>Chegada: <strong>${openRecord.chegadaHora}</strong> | Tempo decorrido: <strong>${formatDurationHMS(elapsedSec)}</strong></div>
    `;
  } else {
    previewBox.className = "exit-preview-box";
    previewBox.innerHTML = `<span>Nenhum registro em aberto encontrado para o RE <strong>${rawRe}</strong>.</span>`;
  }
}

async function registrarSaidaParaRegistro(record, reSaidaInformado) {
  const now = new Date();
  const saidaTs = now.getTime();
  const duracaoSegundos = Math.max(1, Math.floor((saidaTs - record.chegadaTs) / 1000));

  const atualizado = {
    ...record,
    saidaTs,
    saidaHora: formatHora(now),
    reSaida: String(reSaidaInformado || record.reEntrada).trim(),
    duracaoSegundos
  };

  await persistRecord(atualizado);
  showToast(
    `Saída registrada: RE ${atualizado.reSaida} (${atualizado.nome}) — Permanência: ${formatDurationHMS(duracaoSegundos)}`
  );
}

async function handleFormSaidaRapida(event) {
  event.preventDefault();
  const inputEl = document.getElementById("inputReSaidaRapida");
  const rawRe = inputEl.value.trim();
  if (!rawRe) return;

  const norm = normalizeRe(rawRe);
  // Pega o registro em aberto mais antigo ou atual desse RE
  const candidatos = registrosReserva.filter(
    (r) => !r.saidaTs && normalizeRe(r.reEntrada) === norm
  );

  if (candidatos.length === 0) {
    showToast(`O RE ${rawRe} não possui entrada em aberto na reserva no momento.`);
    return;
  }

  const alvo = candidatos[candidatos.length - 1];
  await registrarSaidaParaRegistro(alvo, rawRe);

  inputEl.value = "";
  handleReSaidaRapidaTyping();
  inputEl.focus();
}

// ============================================================================
// RENDERIZAÇÃO DA TABELA DE CONTROLE DA RESERVA E RESUMO LATERAL
// ============================================================================
function getFilteredTableRecords() {
  const filterDate = document.getElementById("filterDate")?.value || "";
  const filterStatus = document.getElementById("filterStatus")?.value || "todos";
  const searchText = (document.getElementById("filterSearchText")?.value || "").trim().toLowerCase();

  return registrosReserva.filter((r) => {
    if (filterDate && r.dataIso !== filterDate) {
      return false;
    }
    if (filterStatus === "abertos" && r.saidaTs) {
      return false;
    }
    if (filterStatus === "concluidos" && !r.saidaTs) {
      return false;
    }
    if (searchText) {
      const hay = `${r.reEntrada} ${r.nome} ${r.funcao} ${r.supervisor || ""} ${r.posto || ""} ${r.observacao || ""}`.toLowerCase();
      if (!hay.includes(searchText)) return false;
    }
    return true;
  });
}

function renderReservaTable() {
  const tbody = document.getElementById("reservaTableBody");
  const counterEl = document.getElementById("tableRecordsCounter");
  if (!tbody) return;

  const filtered = getFilteredTableRecords();
  if (counterEl) {
    counterEl.textContent = `${filtered.length} ${filtered.length === 1 ? "registro exibido" : "registros exibidos"}`;
  }

  if (filtered.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="12" class="empty-table-msg">
          Nenhum registro encontrado para os filtros selecionados. Digite o <strong>RE - ENTRADA</strong> acima para iniciar os lançamentos do dia.
        </td>
      </tr>
    `;
    return;
  }

  const nowMs = Date.now();
  tbody.innerHTML = "";

  for (const reg of filtered) {
    const isConcluido = Boolean(reg.saidaTs);
    const tr = document.createElement("tr");
    if (!isConcluido) {
      tr.className = "row-open";
    }

    const segundos = isConcluido
      ? reg.duracaoSegundos
      : Math.max(0, Math.floor((nowMs - reg.chegadaTs) / 1000));
    const tempoFormatado = formatDurationHMS(segundos);
    const tempoClass =
      segundos >= 3600
        ? "cell-tempo-overtime"
        : segundos >= 1800
          ? "cell-tempo-warning"
          : isConcluido
            ? "cell-tempo-done"
            : "cell-tempo-active";

    tr.innerHTML = `
      <td class="col-data">${reg.dataDisplay || formatDataCurta(reg.dataIso)}</td>
      <td class="col-re-ent">${escapeHtml(reg.reEntrada)}</td>
      <td class="col-nome">${escapeHtml(reg.nome)}</td>
      <td class="col-funcao">${escapeHtml(reg.funcao)}</td>
      <td class="col-chegada">${escapeHtml(reg.chegadaHora)}</td>
      <td class="col-saida">${isConcluido ? escapeHtml(reg.saidaHora) : "—"}</td>
      <td class="col-re-sai"></td>
      <td class="col-sup">
        <input type="text" class="inline-edit-input" data-field="supervisor" value="${escapeAttr(reg.supervisor || "")}" placeholder="Supervisor..." />
      </td>
      <td class="col-posto">
        <input type="text" class="inline-edit-input" data-field="posto" value="${escapeAttr(reg.posto || "")}" placeholder="Posto..." />
      </td>
      <td class="col-obs">
        <input type="text" class="inline-edit-input" data-field="observacao" value="${escapeAttr(reg.observacao || "")}" placeholder="Observação..." />
      </td>
      <td class="col-tempo ${tempoClass}" data-live-timer="${isConcluido ? "" : reg.chegadaTs}">
        ${tempoFormatado}
      </td>
      <td class="col-acoes">
        <button type="button" class="btn-delete-row" title="Excluir registro">&times;</button>
      </td>
    `;

    // Coluna RE - SAÍDA: se estiver em aberto, mostra input para digitar o RE ou botão rápido
    const cellReSaida = tr.querySelector(".col-re-sai");
    if (isConcluido) {
      cellReSaida.innerHTML = `<span class="re-saida-confirmed">${escapeHtml(reg.reSaida || reg.reEntrada)}</span>`;
    } else {
      const box = document.createElement("div");
      box.className = "inline-re-saida-box";

      const inp = document.createElement("input");
      inp.type = "text";
      inp.className = "inline-re-saida-input";
      inp.placeholder = "RE Saída";
      inp.title = `Digite o RE (${reg.reEntrada}) e pressione Enter para registrar a saída`;

      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "btn-inline-saida";
      btn.textContent = "Saída";
      btn.title = `Confirmar saída de ${reg.nome} (RE ${reg.reEntrada})`;

      const triggerExit = async () => {
        const typed = inp.value.trim();
        if (typed && normalizeRe(typed) !== normalizeRe(reg.reEntrada)) {
          showToast(`Atenção: o RE de saída digitado (${typed}) difere do RE de entrada (${reg.reEntrada}).`);
          return;
        }
        await registrarSaidaParaRegistro(reg, typed || reg.reEntrada);
      };

      inp.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          triggerExit();
        }
      });

      btn.addEventListener("click", triggerExit);

      box.appendChild(inp);
      box.appendChild(btn);
      cellReSaida.appendChild(box);
    }

    // Eventos de edição inline (Supervisor, Posto, Observação)
    const inlineInputs = tr.querySelectorAll(".inline-edit-input");
    inlineInputs.forEach((inputEl) => {
      const saveField = async () => {
        const field = inputEl.dataset.field;
        const newVal = field === "observacao" ? inputEl.value.trim() : inputEl.value.trim().toUpperCase();
        if ((reg[field] || "") !== newVal) {
          const updated = { ...reg, [field]: newVal };
          await persistRecord(updated);
          showToast(`${field.toUpperCase()} atualizado para ${reg.nome}.`);
        }
      };

      inputEl.addEventListener("change", saveField);
      inputEl.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          inputEl.blur();
        }
      });
    });

    // Botão excluir
    const btnDel = tr.querySelector(".btn-delete-row");
    btnDel.addEventListener("click", async () => {
      if (confirm(`Deseja realmente remover o registro de ${reg.nome} (RE ${reg.reEntrada})?`)) {
        await deleteRecordById(reg.id);
        showToast("Registro removido.");
      }
    });

    tbody.appendChild(tr);
  }
}

function renderSidebarSummary() {
  const todayIso = getTodayIso();
  const registrosHoje = registrosReserva.filter((r) => r.dataIso === todayIso);
  const presentes = registrosHoje.filter((r) => !r.saidaTs);
  const concluidos = registrosHoje.filter((r) => Boolean(r.saidaTs));

  let somaSegundos = 0;
  const nowMs = Date.now();
  for (const r of registrosHoje) {
    somaSegundos += r.saidaTs
      ? Number(r.duracaoSegundos || 0)
      : Math.max(0, Math.floor((nowMs - r.chegadaTs) / 1000));
  }
  const mediaHoje = registrosHoje.length > 0 ? Math.floor(somaSegundos / registrosHoje.length) : 0;

  const elPresentes = document.getElementById("sideCountPresentes");
  const elSaidas = document.getElementById("sideCountSaidas");
  const elTotal = document.getElementById("sideCountTotalHoje");
  const elMedia = document.getElementById("sideTempoMedioHoje");

  if (elPresentes) elPresentes.textContent = String(presentes.length);
  if (elSaidas) elSaidas.textContent = String(concluidos.length);
  if (elTotal) elTotal.textContent = String(registrosHoje.length);
  if (elMedia) elMedia.textContent = formatDurationHMS(mediaHoje);
}

// ============================================================================
// ABA 2: INDICADORES GERENCIAIS (SGPQ / SGPQ123)
// ============================================================================
function updateSgpqAuthView() {
  const gate = document.getElementById("authGateContainer");
  const content = document.getElementById("indicadoresContent");
  const lockBadge = document.getElementById("indicadoresLockBadge");

  if (isSgpqAuthenticated) {
    if (gate) gate.hidden = true;
    if (content) content.hidden = false;
    if (lockBadge) lockBadge.style.display = "none";
    renderIndicadores();
  } else {
    if (gate) gate.hidden = false;
    if (content) content.hidden = true;
    if (lockBadge) lockBadge.style.display = "inline-flex";
  }
}

function populateCargoFilterOptions() {
  const select = document.getElementById("indCargoFilter");
  if (!select) return;
  const currentVal = select.value;
  const cargosSet = new Set();

  for (const r of registrosReserva) {
    if (r.funcao) cargosSet.add(r.funcao);
  }
  for (const c of colaboradoresList) {
    if (c.funcao) cargosSet.add(c.funcao);
  }

  const sortedCargos = Array.from(cargosSet).sort((a, b) => a.localeCompare(b, "pt-BR"));
  select.innerHTML = `<option value="todos">Todos os Cargos (${sortedCargos.length})</option>`;
  for (const cargo of sortedCargos) {
    const opt = document.createElement("option");
    opt.value = cargo;
    opt.textContent = cargo;
    select.appendChild(opt);
  }
  if (sortedCargos.includes(currentVal)) {
    select.value = currentVal;
  }
}

function getFilteredIndicadoresRecords() {
  const periodVal = document.getElementById("indPeriodSelect")?.value || "30";
  const cargoVal = document.getElementById("indCargoFilter")?.value || "todos";
  const todayIso = getTodayIso();

  let minIso = null;
  let maxIso = null;

  if (periodVal === "hoje") {
    minIso = todayIso;
    maxIso = todayIso;
  } else if (periodVal === "7" || periodVal === "30") {
    const days = parseInt(periodVal, 10);
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - (days - 1));
    minIso = getTodayIso(cutoff);
  } else if (periodVal === "custom") {
    minIso = document.getElementById("indDateStart")?.value || null;
    maxIso = document.getElementById("indDateEnd")?.value || null;
  }

  return registrosReserva.filter((r) => {
    if (minIso && r.dataIso < minIso) return false;
    if (maxIso && r.dataIso > maxIso) return false;
    if (cargoVal !== "todos" && r.funcao !== cargoVal) return false;
    return true;
  });
}

function getRecordDurationSec(reg, nowMs = Date.now()) {
  if (reg.saidaTs) {
    return Math.max(0, Number(reg.duracaoSegundos || 0));
  }
  return Math.max(0, Math.floor((nowMs - (reg.chegadaTs || nowMs)) / 1000));
}

function renderIndicadores() {
  if (!isSgpqAuthenticated) return;

  const records = getFilteredIndicadoresRecords();
  const nowMs = Date.now();

  const totalPassagens = records.length;
  const concluidos = records.filter((r) => Boolean(r.saidaTs));
  const abertos = records.filter((r) => !r.saidaTs);

  let somaDuracao = 0;
  for (const r of records) {
    somaDuracao += getRecordDurationSec(r, nowMs);
  }
  const tempoMedioSec = totalPassagens > 0 ? Math.floor(somaDuracao / totalPassagens) : 0;

  // Agrupamento por Dia
  const porDiaMap = new Map();
  for (const r of records) {
    const dia = r.dataIso || "Sem Data";
    if (!porDiaMap.has(dia)) {
      porDiaMap.set(dia, { dataIso: dia, total: 0, concluidos: 0, abertos: 0, somaSec: 0 });
    }
    const item = porDiaMap.get(dia);
    item.total++;
    if (r.saidaTs) item.concluidos++;
    else item.abertos++;
    item.somaSec += getRecordDurationSec(r, nowMs);
  }
  const diasList = Array.from(porDiaMap.values()).sort((a, b) => b.dataIso.localeCompare(a.dataIso));
  const mediaPorDia = diasList.length > 0 ? (totalPassagens / diasList.length).toFixed(1).replace(".", ",") : "0";

  // Agrupamento por Cargo / Função
  const porCargoMap = new Map();
  for (const r of records) {
    const cargo = r.funcao || "NÃO INFORMADO";
    if (!porCargoMap.has(cargo)) {
      porCargoMap.set(cargo, { cargo, count: 0, somaSec: 0, maxSec: 0 });
    }
    const cItem = porCargoMap.get(cargo);
    const dSec = getRecordDurationSec(r, nowMs);
    cItem.count++;
    cItem.somaSec += dSec;
    if (dSec > cItem.maxSec) cItem.maxSec = dSec;
  }
  const cargosList = Array.from(porCargoMap.values()).sort((a, b) => b.count - a.count);

  // Atualiza os 4 Cards de KPI
  document.getElementById("kpiTempoMedio").textContent = formatDurationHMS(tempoMedioSec);
  document.getElementById("kpiTempoMedioHoras").textContent = `Média de ${formatHoursHuman(tempoMedioSec)}`;
  document.getElementById("kpiTotalPassagens").textContent = String(totalPassagens);
  document.getElementById("kpiMediaPorDia").textContent = `Média de ${mediaPorDia} colaboradores / dia (${diasList.length} ${diasList.length === 1 ? "dia" : "dias"})`;
  document.getElementById("kpiConcluidosVsAbertos").textContent = `${concluidos.length} / ${abertos.length}`;
  const taxa = totalPassagens > 0 ? Math.round((concluidos.length / totalPassagens) * 100) : 0;
  document.getElementById("kpiTaxaConclusao").textContent = `Taxa de saída registrada: ${taxa}%`;

  if (cargosList.length > 0) {
    const top = cargosList[0];
    const pctTop = Math.round((top.count / totalPassagens) * 100);
    document.getElementById("kpiTopCargo").textContent = top.cargo;
    document.getElementById("kpiTopCargoCount").textContent = `${top.count} colaboradores (${pctTop}% do total)`;
  } else {
    document.getElementById("kpiTopCargo").textContent = "—";
    document.getElementById("kpiTopCargoCount").textContent = "0 registros no período";
  }

  // Renderiza Gráfico Diário + Tabela Diária
  const dailyChartEl = document.getElementById("dailyChartContainer");
  const dailyTableBody = document.getElementById("dailyTableBody");

  if (diasList.length === 0) {
    dailyChartEl.innerHTML = `<div style="margin:auto;color:var(--text-muted);font-size:12px;">Sem dados no período selecionado.</div>`;
    dailyTableBody.innerHTML = `<tr><td colspan="5" style="text-align:center;color:var(--text-muted);">Nenhum registro no período.</td></tr>`;
  } else {
    const cronologico = [...diasList].reverse().slice(-14);
    const maxDia = Math.max(...cronologico.map((d) => d.total), 1);

    dailyChartEl.innerHTML = cronologico
      .map((d) => {
        const alturaPx = Math.max(6, Math.round((d.total / maxDia) * 92));
        return `
          <div class="daily-bar-col" title="${formatDataCompleta(d.dataIso)}: ${d.total} colaboradores">
            <span class="daily-bar-val">${d.total}</span>
            <div class="daily-bar-fill" style="height: ${alturaPx}px;"></div>
            <span class="daily-bar-date">${formatDataCurta(d.dataIso)}</span>
          </div>
        `;
      })
      .join("");

    dailyTableBody.innerHTML = diasList
      .map((d) => {
        const mediaDia = d.total > 0 ? Math.floor(d.somaSec / d.total) : 0;
        return `
          <tr>
            <td><strong>${formatDataCompleta(d.dataIso)}</strong></td>
            <td class="num"><strong>${d.total}</strong></td>
            <td class="num">${d.concluidos}</td>
            <td class="num">${d.abertos}</td>
            <td class="num"><strong>${formatDurationHMS(mediaDia)}</strong></td>
          </tr>
        `;
      })
      .join("");
  }

  // Renderiza Barras e Tabela por Cargo / Função
  const cargoBarsEl = document.getElementById("cargoBarsContainer");
  const cargoTableBody = document.getElementById("cargoTableBody");

  if (cargosList.length === 0) {
    cargoBarsEl.innerHTML = `<div style="margin:auto;color:var(--text-muted);font-size:12px;">Sem dados de cargos no período.</div>`;
    cargoTableBody.innerHTML = `<tr><td colspan="5" style="text-align:center;color:var(--text-muted);">Nenhum registro no período.</td></tr>`;
  } else {
    cargoBarsEl.innerHTML = cargosList
      .slice(0, 6)
      .map((c) => {
        const pct = totalPassagens > 0 ? ((c.count / totalPassagens) * 100).toFixed(1) : "0.0";
        const mediaCargo = Math.floor(c.somaSec / c.count);
        return `
          <div class="cargo-bar-item">
            <div class="cargo-bar-top">
              <span>${escapeHtml(c.cargo)}</span>
              <span>${c.count} colab. (${pct.replace(".", ",")}%) • Média: ${formatDurationHMS(mediaCargo)}</span>
            </div>
            <div class="cargo-bar-track">
              <div class="cargo-bar-fill" style="width: ${Math.max(3, parseFloat(pct))}%;"></div>
            </div>
          </div>
        `;
      })
      .join("");

    cargoTableBody.innerHTML = cargosList
      .map((c) => {
        const pct = totalPassagens > 0 ? ((c.count / totalPassagens) * 100).toFixed(1).replace(".", ",") : "0,0";
        const mediaCargo = Math.floor(c.somaSec / c.count);
        return `
          <tr>
            <td><strong>${escapeHtml(c.cargo)}</strong></td>
            <td class="num"><strong>${c.count}</strong></td>
            <td class="num">${pct}%</td>
            <td class="num"><strong>${formatDurationHMS(mediaCargo)}</strong></td>
            <td class="num">${formatDurationHMS(c.maxSec)}</td>
          </tr>
        `;
      })
      .join("");
  }

  // Tabelas Secundárias: Supervisor e Posto
  renderGroupTable(records, "supervisor", "supervisorTableBody", "NÃO INFORMADO", nowMs);
  renderGroupTable(records, "posto", "postoTableBody", "NÃO INFORMADO", nowMs);
}

function renderGroupTable(records, fieldName, tbodyId, emptyLabel, nowMs) {
  const tbody = document.getElementById(tbodyId);
  if (!tbody) return;

  if (records.length === 0) {
    tbody.innerHTML = `<tr><td colspan="4" style="text-align:center;color:var(--text-muted);">Sem registros no período.</td></tr>`;
    return;
  }

  const map = new Map();
  for (const r of records) {
    const key = (r[fieldName] || "").trim() || emptyLabel;
    if (!map.has(key)) {
      map.set(key, { label: key, count: 0, somaSec: 0 });
    }
    const item = map.get(key);
    item.count++;
    item.somaSec += getRecordDurationSec(r, nowMs);
  }

  const list = Array.from(map.values()).sort((a, b) => b.count - a.count);
  tbody.innerHTML = list
    .map((item) => {
      const pct = ((item.count / records.length) * 100).toFixed(1).replace(".", ",");
      const avg = Math.floor(item.somaSec / item.count);
      return `
        <tr>
          <td><strong>${escapeHtml(item.label)}</strong></td>
          <td class="num"><strong>${item.count}</strong></td>
          <td class="num">${pct}%</td>
          <td class="num">${formatDurationHMS(avg)}</td>
        </tr>
      `;
    })
    .join("");
}

// ============================================================================
// ABA 3: CONSULTA DA BASE DE COLABORADORES (GOOGLE SHEETS)
// ============================================================================
function renderBaseColaboradoresTable() {
  const tbody = document.getElementById("baseColaboradoresTableBody");
  if (!tbody) return;

  const query = (document.getElementById("searchBaseColaboradores")?.value || "").trim().toLowerCase();
  const filtered = query
    ? colaboradoresList.filter(
        (c) =>
          c.re.toLowerCase().includes(query) ||
          c.nome.toLowerCase().includes(query) ||
          c.funcao.toLowerCase().includes(query)
      )
    : colaboradoresList;

  const slice = filtered.slice(0, 150);

  if (slice.length === 0) {
    tbody.innerHTML = `<tr><td colspan="4" class="empty-table-msg">Nenhum colaborador encontrado para "${escapeHtml(query)}".</td></tr>`;
    return;
  }

  tbody.innerHTML = slice
    .map(
      (c) => `
      <tr>
        <td class="col-re-ent">${escapeHtml(c.re)}</td>
        <td class="col-nome">${escapeHtml(c.nome)}</td>
        <td class="col-funcao">${escapeHtml(c.funcao)}</td>
        <td style="text-align: right;">
          <button type="button" class="btn-secondary btn-lancar-re" data-re="${escapeAttr(c.re)}" style="height:28px;font-size:11.5px;">
            Lançar na Reserva
          </button>
        </td>
      </tr>
    `
    )
    .join("");

  tbody.querySelectorAll(".btn-lancar-re").forEach((btn) => {
    btn.addEventListener("click", () => {
      const re = btn.dataset.re;
      switchTab("operacao");
      const inputRe = document.getElementById("inputReEntrada");
      inputRe.value = re;
      handleReEntradaTyping();
      inputRe.focus();
    });
  });
}

// ============================================================================
// EXPORTAÇÃO PARA EXCEL (CSV COM BOM UTF-8 PARA ACENTUAÇÃO CORRETA NO EXCEL)
// ============================================================================
function exportToCsv(filename, headers, rows) {
  const sep = ";";
  const csvContent = [
    headers.join(sep),
    ...rows.map((row) =>
      row.map((val) => `"${String(val ?? "").replace(/"/g, '""')}"`).join(sep)
    )
  ].join("\r\n");

  const blob = new Blob(["\uFEFF" + csvContent], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function handleExportTableCsv() {
  const records = getFilteredTableRecords();
  if (records.length === 0) {
    showToast("Não há registros na tabela para exportar.");
    return;
  }

  const headers = [
    "DATA",
    "RE - ENTRADA",
    "NOME",
    "FUNÇÃO",
    "CHEGADA",
    "SAÍDA",
    "RE - SAIDA",
    "SUPERVISOR",
    "POSTO",
    "OBSERVAÇÃO",
    "TEMPO"
  ];

  const nowMs = Date.now();
  const rows = records.map((r) => [
    r.dataDisplay || formatDataCurta(r.dataIso),
    r.reEntrada,
    r.nome,
    r.funcao,
    r.chegadaHora,
    r.saidaHora || "",
    r.reSaida || "",
    r.supervisor || "",
    r.posto || "",
    r.observacao || "",
    formatDurationHMS(getRecordDurationSec(r, nowMs))
  ]);

  exportToCsv(`controle_reserva_embraps_${getTodayIso()}.csv`, headers, rows);
  showToast("Planilha exportada com sucesso.");
}

function handleExportIndicadoresCsv() {
  const records = getFilteredIndicadoresRecords();
  if (records.length === 0) {
    showToast("Não há dados no período selecionado para exportar.");
    return;
  }

  const headers = [
    "DATA",
    "RE - ENTRADA",
    "NOME",
    "FUNÇÃO",
    "CHEGADA",
    "SAÍDA",
    "RE - SAIDA",
    "SUPERVISOR",
    "POSTO",
    "OBSERVAÇÃO",
    "TEMPO (HH:MM:SS)",
    "TEMPO (SEGUNDOS)"
  ];

  const nowMs = Date.now();
  const rows = records.map((r) => {
    const sec = getRecordDurationSec(r, nowMs);
    return [
      formatDataCompleta(r.dataIso),
      r.reEntrada,
      r.nome,
      r.funcao,
      r.chegadaHora,
      r.saidaHora || "EM ABERTO",
      r.reSaida || "",
      r.supervisor || "",
      r.posto || "",
      r.observacao || "",
      formatDurationHMS(sec),
      sec
    ];
  });

  exportToCsv(`relatorio_indicadores_sgpq_${getTodayIso()}.csv`, headers, rows);
  showToast("Relatório de indicadores exportado.");
}

// ============================================================================
// ESCAPE DE HTML E NAVEGAÇÃO DE ABAS
// ============================================================================
function escapeHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeAttr(str) {
  return escapeHtml(str);
}

function switchTab(tabName) {
  document.querySelectorAll(".nav-item").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.tab === tabName);
  });

  document.getElementById("panelOperacao").classList.toggle("active", tabName === "operacao");
  document.getElementById("panelIndicadores").classList.toggle("active", tabName === "indicadores");
  document.getElementById("panelColaboradores").classList.toggle("active", tabName === "colaboradores");

  if (tabName === "indicadores") {
    updateSgpqAuthView();
    if (!isSgpqAuthenticated) {
      setTimeout(() => document.getElementById("loginUsername")?.focus(), 50);
    }
  } else if (tabName === "colaboradores") {
    renderBaseColaboradoresTable();
  }
}

function renderAll() {
  renderReservaTable();
  renderSidebarSummary();
  populateCargoFilterOptions();
  if (isSgpqAuthenticated) {
    renderIndicadores();
  }
}

// ============================================================================
// RELÓGIO E CRONÔMETRO EM TEMPO REAL (1 SEGUNDO)
// ============================================================================
function startLiveTicker() {
  const tick = () => {
    const now = new Date();
    const dateEl = document.getElementById("liveDate");
    const timeEl = document.getElementById("liveTime");
    if (dateEl) dateEl.textContent = formatDataCompleta(getTodayIso(now));
    if (timeEl) timeEl.textContent = formatHora(now);

    // Atualiza células de TEMPO que estão em aberto na reserva
    const nowMs = now.getTime();
    document.querySelectorAll("[data-live-timer]").forEach((cell) => {
      const ts = Number(cell.getAttribute("data-live-timer"));
      if (ts > 0) {
        const sec = Math.max(0, Math.floor((nowMs - ts) / 1000));
        cell.textContent = formatDurationHMS(sec);
        if (sec >= 3600) {
          if (!cell.classList.contains("cell-tempo-overtime")) {
            cell.classList.remove("cell-tempo-active", "cell-tempo-warning", "cell-tempo-done");
            cell.classList.add("cell-tempo-overtime");
          }
        } else if (sec >= 1800) {
          if (!cell.classList.contains("cell-tempo-warning")) {
            cell.classList.remove("cell-tempo-active", "cell-tempo-overtime", "cell-tempo-done");
            cell.classList.add("cell-tempo-warning");
          }
        }
      }
    });

    renderSidebarSummary();
  };

  tick();
  setInterval(tick, 1000);
}

// ============================================================================
// INICIALIZAÇÃO DE EVENTOS
// ============================================================================
function setupEventListeners() {
  // Navegação Lateral
  document.querySelectorAll(".nav-item").forEach((btn) => {
    btn.addEventListener("click", () => switchTab(btn.dataset.tab));
  });

  // Entrada de Colaborador
  const inputReEntrada = document.getElementById("inputReEntrada");
  inputReEntrada.addEventListener("input", handleReEntradaTyping);
  document.getElementById("formEntrada").addEventListener("submit", handleRegistrarEntrada);

  // Saída Rápida por RE
  const inputReSaida = document.getElementById("inputReSaidaRapida");
  inputReSaida.addEventListener("input", handleReSaidaRapidaTyping);
  document.getElementById("formSaidaRapida").addEventListener("submit", handleFormSaidaRapida);

  // Filtros da Tabela Operacional
  const filterDate = document.getElementById("filterDate");
  filterDate.value = getTodayIso();
  filterDate.addEventListener("change", renderReservaTable);

  document.getElementById("btnShowToday").addEventListener("click", () => {
    filterDate.value = getTodayIso();
    renderReservaTable();
  });

  document.getElementById("btnShowAllDates").addEventListener("click", () => {
    filterDate.value = "";
    renderReservaTable();
  });

  document.getElementById("filterStatus").addEventListener("change", renderReservaTable);
  document.getElementById("filterSearchText").addEventListener("input", renderReservaTable);
  document.getElementById("btnExportCsv").addEventListener("click", handleExportTableCsv);

  // Botões de Atualizar Google Sheets
  document.getElementById("btnRefreshSheets").addEventListener("click", () => syncGoogleSheets(true));
  document.getElementById("btnReloadSheetsTab").addEventListener("click", () => syncGoogleSheets(true));
  document.getElementById("searchBaseColaboradores").addEventListener("input", renderBaseColaboradoresTable);

  // Login SGPQ (usuário: SGPQ / senha: SGPQ123)
  document.getElementById("formLoginSgpq").addEventListener("submit", (e) => {
    e.preventDefault();
    const user = document.getElementById("loginUsername").value.trim();
    const pass = document.getElementById("loginPassword").value.trim();
    const errorEl = document.getElementById("loginErrorMsg");

    if (user.toUpperCase() === "SGPQ" && pass === "SGPQ123") {
      isSgpqAuthenticated = true;
      sessionStorage.setItem(STORAGE_KEYS.SGPQ_AUTH, "true");
      errorEl.hidden = true;
      document.getElementById("loginPassword").value = "";
      updateSgpqAuthView();
      showToast("Acesso SGPQ liberado.");
    } else {
      errorEl.hidden = false;
    }
  });

  document.getElementById("btnLogoutSgpq").addEventListener("click", () => {
    isSgpqAuthenticated = false;
    sessionStorage.removeItem(STORAGE_KEYS.SGPQ_AUTH);
    updateSgpqAuthView();
    showToast("Aba de indicadores bloqueada.");
  });

  // Filtros de Indicadores
  const indPeriodSelect = document.getElementById("indPeriodSelect");
  const indCustomDatesBox = document.getElementById("indCustomDatesBox");
  indPeriodSelect.addEventListener("change", () => {
    indCustomDatesBox.hidden = indPeriodSelect.value !== "custom";
    renderIndicadores();
  });
  document.getElementById("indDateStart").addEventListener("change", renderIndicadores);
  document.getElementById("indDateEnd").addEventListener("change", renderIndicadores);
  document.getElementById("indCargoFilter").addEventListener("change", renderIndicadores);
  document.getElementById("btnExportIndicadoresCsv").addEventListener("click", handleExportIndicadoresCsv);

  // Modal Firebase
  const modal = document.getElementById("firebaseModalBackdrop");
  document.getElementById("btnOpenFirebaseModal").addEventListener("click", () => {
    const cfg = getActiveFirebaseConfig() || {};
    document.getElementById("fbApiKey").value = cfg.apiKey || "";
    document.getElementById("fbAuthDomain").value = cfg.authDomain || "";
    document.getElementById("fbProjectId").value = cfg.projectId || "";
    document.getElementById("fbStorageBucket").value = cfg.storageBucket || "";
    document.getElementById("fbMessagingSenderId").value = cfg.messagingSenderId || "";
    document.getElementById("fbAppId").value = cfg.appId || "";
    modal.hidden = false;
  });

  document.getElementById("btnCloseFirebaseModal").addEventListener("click", () => {
    modal.hidden = true;
  });

  document.getElementById("formFirebaseConfig").addEventListener("submit", async (e) => {
    e.preventDefault();
    const newCfg = {
      apiKey: document.getElementById("fbApiKey").value.trim(),
      authDomain: document.getElementById("fbAuthDomain").value.trim(),
      projectId: document.getElementById("fbProjectId").value.trim(),
      storageBucket: document.getElementById("fbStorageBucket").value.trim(),
      messagingSenderId: document.getElementById("fbMessagingSenderId").value.trim(),
      appId: document.getElementById("fbAppId").value.trim()
    };
    localStorage.setItem(STORAGE_KEYS.FIREBASE_CONFIG, JSON.stringify(newCfg));
    await initFirebaseConnection();
    modal.hidden = true;
    showToast("Configuração do Firebase salva.");
  });

  document.getElementById("btnClearFirebaseConfig").addEventListener("click", () => {
    localStorage.removeItem(STORAGE_KEYS.FIREBASE_CONFIG);
    if (firestoreUnsubscribe) firestoreUnsubscribe();
    firebaseConnected = false;
    initFirebaseConnection();
    showToast("Desconectado do Firebase (usando armazenamento local).");
  });

  document.getElementById("btnSyncLocalToFirebase").addEventListener("click", async () => {
    if (!firebaseConnected || !firestoreDb || !firebaseFunctions) {
      showToast("Conecte o Firebase primeiro antes de sincronizar os registros locais.");
      return;
    }
    let count = 0;
    for (const r of registrosReserva) {
      const docRef = firebaseFunctions.doc(firestoreDb, "registros_reserva", r.id);
      await firebaseFunctions.setDoc(docRef, r, { merge: true });
      count++;
    }
    showToast(`${count} registros sincronizados para o Firebase com sucesso.`);
  });
}

// ============================================================================
// BOOTSTRAP DA APLICAÇÃO
// ============================================================================
async function initApp() {
  loadCachedColaboradores();
  loadLocalRecords();
  setupEventListeners();
  startLiveTicker();
  renderAll();
  await Promise.all([syncGoogleSheets(false), initFirebaseConnection()]);
}

initApp();

