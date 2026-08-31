(() => {
  const balanceEl = document.getElementById("balance");
  const debtTotalEl = document.getElementById("debt-total");
  const debtsContainer = document.getElementById("debts-container");
  const debtsEmptyEl = document.getElementById("debts-empty");
  const listEl = document.getElementById("tx-list");
  const emptyEl = document.getElementById("empty-state");

  const form = document.getElementById("tx-form");
  const amountInput = document.getElementById("amount");
  const noteInput = document.getElementById("note");
  const errorEl = document.getElementById("form-error");
  const submitBtn = document.getElementById("submit-btn");
  const tabs = document.querySelectorAll("[data-kind]");

  const addDebtBtn = document.getElementById("add-debt-btn");
  const addDebtPanel = document.getElementById("add-debt-panel");
  const addDebtForm = document.getElementById("add-debt-form");
  const newDebtNameInput = document.getElementById("new-debt-name");
  const newDebtAmountInput = document.getElementById("new-debt-amount");
  const addDebtErrorEl = document.getElementById("add-debt-error");
  const addDebtSubmitBtn = document.getElementById("add-debt-submit-btn");
  const cancelAddDebtBtn = document.getElementById("cancel-add-debt-btn");
  const clearTxBtn = document.getElementById("clear-tx-btn");
  const nextIncomeEl = document.getElementById("next-income");

  let kind = "income";
  const debtKinds = new Map();

  const moneyFmt = new Intl.NumberFormat("ru-RU", {
    style: "currency",
    currency: "RUB",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

  const dateFmt = new Intl.DateTimeFormat("ru-RU", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });

  function formatMoney(value) {
    return moneyFmt.format(Number(value) || 0);
  }

  function groupThousands(intDigits) {
    const cleaned = intDigits.replace(/^0+(?=\d)/, "") || "0";
    return cleaned.replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  }

  function formatAmountDisplay(raw) {
    const normalized = String(raw).replace(/[^\d.,]/g, "").replace(",", ".");
    if (!normalized) {
      return "";
    }

    const hasDot = normalized.includes(".");
    let [intPart = "", fracPart = ""] = normalized.split(".");
    intPart = intPart.replace(/\D/g, "");
    fracPart = fracPart.replace(/\D/g, "").slice(0, 2);

    if (!intPart && !hasDot) {
      return "";
    }

    const grouped = groupThousands(intPart || "0");
    if (hasDot) {
      return `${grouped}.${fracPart}`;
    }
    return grouped === "0" && intPart === "" ? "" : grouped;
  }

  function parseAmountValue(display) {
    return display.trim().replace(/\s/g, "").replace(",", ".");
  }

  function caretDigitIndex(value, caret) {
    let digits = 0;
    for (let i = 0; i < caret && i < value.length; i += 1) {
      if (/\d/.test(value[i])) {
        digits += 1;
      }
    }
    return digits;
  }

  function caretFromDigitIndex(value, digitIndex) {
    if (digitIndex <= 0) {
      return 0;
    }
    let digits = 0;
    for (let i = 0; i < value.length; i += 1) {
      if (/\d/.test(value[i])) {
        digits += 1;
        if (digits >= digitIndex) {
          return i + 1;
        }
      }
    }
    return value.length;
  }

  function bindAmountInput(input) {
    input.addEventListener("input", () => {
      const prev = input.value;
      const caret = input.selectionStart ?? prev.length;
      const digitsBefore = caretDigitIndex(prev, caret);
      const afterSep = caret > 0 && /[.,]/.test(prev[caret - 1] || "");

      const next = formatAmountDisplay(prev);
      input.value = next;

      let newCaret = caretFromDigitIndex(next, digitsBefore);
      if (afterSep) {
        const sepPos = next.search(/[.]/);
        if (sepPos !== -1) {
          newCaret = Math.max(newCaret, sepPos + 1);
        }
      }
      input.setSelectionRange(newCaret, newCaret);
    });
  }

  function setError(el, message) {
    if (!message) {
      el.hidden = true;
      el.textContent = "";
      return;
    }
    el.hidden = false;
    el.textContent = message;
  }

  function setKind(next) {
    kind = next;
    tabs.forEach((tab) => {
      const active = tab.dataset.kind === kind;
      tab.classList.toggle("is-active", active);
      tab.setAttribute("aria-selected", active ? "true" : "false");
    });
    submitBtn.classList.toggle("is-expense", kind === "expense");
    submitBtn.textContent = kind === "income" ? "Зачислить" : "Списать";
  }

  function getDebtKind(debtId) {
    return debtKinds.get(debtId) || "borrow";
  }

  function setDebtKind(debtId, next) {
    debtKinds.set(debtId, next);
    const item = debtsContainer.querySelector(`[data-debt-id="${debtId}"]`);
    if (!item) {
      return;
    }

    item.querySelectorAll("[data-debt-kind]").forEach((tab) => {
      const active = tab.dataset.debtKind === next;
      tab.classList.toggle("is-active", active);
      tab.setAttribute("aria-selected", active ? "true" : "false");
    });

    const submit = item.querySelector(".debt-submit");
    const hint = item.querySelector(".debt-hint");
    submit.classList.toggle("is-repay", next === "repay");
    if (next === "borrow") {
      submit.textContent = "Записать долг";
      hint.textContent = "Увеличивает этот долг, доступные деньги не меняются";
    } else {
      submit.textContent = "Вернуть и списать";
      hint.textContent =
        "Уменьшает этот долг и сразу списывает ту же сумму из «Доступно»";
    }
  }

  function makeItem({ title, meta, amountText, amountClass }) {
    const li = document.createElement("li");
    li.className = "item";

    const titleEl = document.createElement("div");
    titleEl.className = "item-title";
    titleEl.textContent = title;

    const metaEl = document.createElement("div");
    metaEl.className = "item-meta";
    metaEl.textContent = meta;

    const amountEl = document.createElement("div");
    amountEl.className = `item-amount ${amountClass}`;
    amountEl.textContent = amountText;

    li.append(titleEl, metaEl, amountEl);
    return li;
  }

  function renderDebtHistory(listEl, emptyEl, transactions) {
    listEl.innerHTML = "";
    emptyEl.hidden = transactions.length > 0;
    for (const tx of transactions) {
      const when = tx.created_at ? dateFmt.format(new Date(tx.created_at)) : "";
      const isBorrow = tx.kind === "borrow";
      listEl.append(
        makeItem({
          title: tx.note || (isBorrow ? "Новый долг" : "Возврат"),
          meta: `${isBorrow ? "Долг" : "Вернул"} · ${when}`,
          amountText: `${isBorrow ? "+" : "−"}${formatMoney(tx.amount)}`,
          amountClass: tx.kind,
        })
      );
    }
  }

  function renderDebtItem(debt) {
    const debtId = debt.id;
    if (!debtKinds.has(debtId)) {
      debtKinds.set(debtId, "borrow");
    }
    const currentKind = getDebtKind(debtId);

    const article = document.createElement("article");
    article.className = "debt-item";
    article.dataset.debtId = String(debtId);

    article.innerHTML = `
      <div class="debt-item-head">
        <h3 class="debt-item-name"></h3>
        <p class="debt-item-balance"></p>
      </div>
      <div class="tabs" role="tablist" aria-label="Тип операции по долгу">
        <button type="button" class="tab ${currentKind === "borrow" ? "is-active" : ""}" role="tab" data-debt-kind="borrow" aria-selected="${currentKind === "borrow"}">Долг</button>
        <button type="button" class="tab ${currentKind === "repay" ? "is-active" : ""}" role="tab" data-debt-kind="repay" aria-selected="${currentKind === "repay"}">Вернул</button>
      </div>
      <form class="form debt-form" novalidate>
        <label class="field">
          <span>Сумма</span>
          <input class="debt-amount-input amount-input" type="text" inputmode="decimal" autocomplete="off" placeholder="1 000.00" required />
        </label>
        <label class="field">
          <span>Комментарий</span>
          <input class="debt-note-input" type="text" maxlength="200" autocomplete="off" placeholder="необязательно" />
        </label>
        <p class="debt-hint"></p>
        <p class="error debt-error" hidden></p>
        <button type="submit" class="submit debt-submit"></button>
      </form>
      <div class="debt-history">
        <div class="history-head">
          <h4 class="debt-history-title">Операции</h4>
          <button type="button" class="clear-btn debt-clear-btn">Удалить</button>
        </div>
        <ul class="list debt-list"></ul>
        <p class="empty debt-empty" hidden>Нет операций</p>
      </div>
    `;

    article.querySelector(".debt-item-name").textContent = debt.name;
    article.querySelector(".debt-item-balance").textContent = formatMoney(debt.balance);
    renderDebtHistory(
      article.querySelector(".debt-list"),
      article.querySelector(".debt-empty"),
      debt.transactions || []
    );
    setDebtKind(debtId, currentKind);

    article.querySelectorAll(".amount-input").forEach(bindAmountInput);
    return article;
  }

  function renderDebts(debts) {
    debtsContainer.innerHTML = "";
    debtsEmptyEl.hidden = debts.length > 0;

    for (const debt of debts) {
      debtsContainer.append(renderDebtItem(debt));
    }

    const activeIds = new Set(debts.map((d) => d.id));
    for (const id of [...debtKinds.keys()]) {
      if (!activeIds.has(id)) {
        debtKinds.delete(id);
      }
    }
  }

  function renderSummary(summary) {
    balanceEl.textContent = formatMoney(summary.balance);
    debtTotalEl.textContent = formatMoney(summary.debt);
    renderDebts(summary.debts || []);

    listEl.innerHTML = "";
    const items = summary.transactions || [];
    emptyEl.hidden = items.length > 0;
    for (const tx of items) {
      const when = tx.created_at ? dateFmt.format(new Date(tx.created_at)) : "";
      listEl.append(
        makeItem({
          title: tx.note || (tx.kind === "income" ? "Поступление" : "Трата"),
          meta: `${tx.kind === "income" ? "Поступило" : "Потратил"} · ${when}`,
          amountText: `${tx.kind === "income" ? "+" : "−"}${formatMoney(tx.amount)}`,
          amountClass: tx.kind,
        })
      );
    }
  }

  async function loadSummary() {
    const res = await fetch("/api/summary");
    if (!res.ok) {
      throw new Error("Не удалось загрузить баланс");
    }
    const data = await res.json();
    renderSummary(data);
  }

  function validateAmount(amount, input, errEl) {
    if (!/^\d+(\.\d{1,2})?$/.test(amount) || Number(amount) <= 0) {
      setError(errEl, "Введите положительную сумму, не больше двух знаков после запятой");
      input.focus();
      return false;
    }
    return true;
  }

  async function submitAmount({ amountInput: input, noteInput: noteEl, errorEl: errEl, submitBtn: btn, endpoint, payload }) {
    setError(errEl, "");
    const amount = parseAmountValue(input.value);
    if (!validateAmount(amount, input, errEl)) {
      return;
    }

    btn.disabled = true;
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          amount,
          note: noteEl.value.trim(),
          ...payload,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "Не удалось сохранить");
      }
      renderSummary(data.summary);
      input.form.reset();
      input.focus();
    } catch (err) {
      setError(errEl, err.message || "Ошибка сети");
    } finally {
      btn.disabled = false;
    }
  }

  function showAddDebtPanel(show) {
    addDebtPanel.hidden = !show;
    addDebtBtn.hidden = show;
    setError(addDebtErrorEl, "");
    if (show) {
      addDebtForm.reset();
      newDebtNameInput.focus();
    }
  }

  tabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      setKind(tab.dataset.kind);
      setError(errorEl, "");
    });
  });

  bindAmountInput(amountInput);
  bindAmountInput(newDebtAmountInput);

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    submitAmount({
      amountInput,
      noteInput,
      errorEl,
      submitBtn,
      endpoint: kind === "income" ? "/api/income" : "/api/expense",
      payload: {},
    });
  });

  addDebtBtn.addEventListener("click", () => showAddDebtPanel(true));
  cancelAddDebtBtn.addEventListener("click", () => showAddDebtPanel(false));

  addDebtForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    setError(addDebtErrorEl, "");

    const name = newDebtNameInput.value.trim();
    if (!name) {
      setError(addDebtErrorEl, "Укажите название долга");
      newDebtNameInput.focus();
      return;
    }

    const amountRaw = parseAmountValue(newDebtAmountInput.value);
    if (amountRaw && (!/^\d+(\.\d{1,2})?$/.test(amountRaw) || Number(amountRaw) <= 0)) {
      setError(addDebtErrorEl, "Сумма должна быть положительной, не больше двух знаков после запятой");
      newDebtAmountInput.focus();
      return;
    }

    addDebtSubmitBtn.disabled = true;
    try {
      const body = { name };
      if (amountRaw) {
        body.amount = amountRaw;
      }
      const res = await fetch("/api/debts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "Не удалось создать долг");
      }
      renderSummary(data.summary);
      showAddDebtPanel(false);
    } catch (err) {
      setError(addDebtErrorEl, err.message || "Ошибка сети");
    } finally {
      addDebtSubmitBtn.disabled = false;
    }
  });

  debtsContainer.addEventListener("click", (event) => {
    const tab = event.target.closest("[data-debt-kind]");
    if (tab) {
      const item = tab.closest("[data-debt-id]");
      setDebtKind(Number(item.dataset.debtId), tab.dataset.debtKind);
      setError(item.querySelector(".debt-error"), "");
      return;
    }

    const clearBtn = event.target.closest(".debt-clear-btn");
    if (clearBtn) {
      const item = clearBtn.closest("[data-debt-id]");
      const debtId = Number(item.dataset.debtId);
      const name = item.querySelector(".debt-item-name").textContent;
      if (
        !window.confirm(
          `Удалить долг «${name}» и всю его историю? Доступный баланс не изменится.`
        )
      ) {
        return;
      }

      clearBtn.disabled = true;
      setError(item.querySelector(".debt-error"), "");
      fetch("/api/debt/clear", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ debt_id: debtId }),
      })
        .then((res) => res.json().then((data) => ({ res, data })))
        .then(({ res, data }) => {
          if (!res.ok) {
            throw new Error(data.error || "Не удалось удалить");
          }
          renderSummary(data.summary);
        })
        .catch((err) => {
          setError(item.querySelector(".debt-error"), err.message || "Ошибка сети");
        })
        .finally(() => {
          clearBtn.disabled = false;
        });
    }
  });

  debtsContainer.addEventListener("submit", (event) => {
    const debtFormEl = event.target.closest(".debt-form");
    if (!debtFormEl) {
      return;
    }
    event.preventDefault();

    const item = debtFormEl.closest("[data-debt-id]");
    const debtId = Number(item.dataset.debtId);
    const debtKindValue = getDebtKind(debtId);

    submitAmount({
      amountInput: debtFormEl.querySelector(".debt-amount-input"),
      noteInput: debtFormEl.querySelector(".debt-note-input"),
      errorEl: debtFormEl.querySelector(".debt-error"),
      submitBtn: debtFormEl.querySelector(".debt-submit"),
      endpoint: debtKindValue === "borrow" ? "/api/debt/borrow" : "/api/debt/repay",
      payload: { debt_id: debtId },
    });
  });

  clearTxBtn.addEventListener("click", () => {
    if (
      !window.confirm(
        "Удалить всю историю доходов и трат? Доступный баланс станет 0. Долги не изменятся."
      )
    ) {
      return;
    }
    clearTxBtn.disabled = true;
    setError(errorEl, "");
    fetch("/api/transactions/clear", { method: "POST" })
      .then((res) => res.json().then((data) => ({ res, data })))
      .then(({ res, data }) => {
        if (!res.ok) {
          throw new Error(data.error || "Не удалось очистить");
        }
        renderSummary(data.summary);
      })
      .catch((err) => setError(errorEl, err.message || "Ошибка сети"))
      .finally(() => {
        clearTxBtn.disabled = false;
      });
  });

  function updateNextIncomeCountdown() {
    if (!nextIncomeEl) {
      return;
    }
    const now = new Date();
    const year = now.getFullYear();
    const month = now.getMonth();
    const date = now.getDate();

    const todayMidnight = new Date(year, month, date);
    let target;

    if (date <= 5) {
      target = new Date(year, month, 5);
    } else if (date <= 20) {
      target = new Date(year, month, 20);
    } else {
      target = new Date(year, month + 1, 5);
    }

    const diffMs = target.getTime() - todayMidnight.getTime();
    const diffDays = Math.round(diffMs / (1000 * 60 * 60 * 24));

    if (diffDays === 0) {
      nextIncomeEl.textContent = `Поступление сегодня (${target.getDate()}-е число)!`;
    } else {
      const abs = Math.abs(diffDays) % 100;
      const rem = abs % 10;
      let word = "дней";
      let verb = "осталось";

      if (abs > 10 && abs < 20) {
        word = "дней";
        verb = "осталось";
      } else if (rem > 1 && rem < 5) {
        word = "дня";
        verb = "осталось";
      } else if (rem === 1) {
        word = "день";
        verb = "остался";
      }

      nextIncomeEl.textContent = `До следующего поступления ${verb} ${diffDays} ${word}`;
    }
  }

  setKind("income");
  updateNextIncomeCountdown();
  loadSummary().catch((err) => {
    setError(errorEl, err.message || "Ошибка загрузки");
    balanceEl.textContent = "—";
    debtTotalEl.textContent = "—";
  });
})();
