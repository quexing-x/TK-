(function () {
  "use strict";

  var root = document.documentElement;
  var body = document.body;
  var appShell = document.getElementById("appShell");
  var overlay = document.getElementById("overlay");
  var modal = document.getElementById("modalDialog");
  var drawer = document.getElementById("detailDrawer");
  var toastStack = document.getElementById("toastStack");
  var activeLayer = null;
  var lastFocus = null;
  var previousBodyOverflow = "";
  var previousBodyPaddingRight = "";
  var dropdownOpen = false;

  function setHidden(element, hidden) {
    if (!element) return;
    element.hidden = hidden;
    element.setAttribute("aria-hidden", hidden ? "true" : "false");
  }

  function getFocusable(container) {
    if (!container) return [];
    return Array.from(container.querySelectorAll("a[href], button, input, select, textarea, [contenteditable='true'], [tabindex]:not([tabindex='-1'])"))
      .filter(function (node) {
        return !node.disabled && !node.hidden && node.getAttribute("aria-hidden") !== "true" && node.offsetParent !== null;
      });
  }

  function setPageInert(inert) {
    if (!appShell) return;
    appShell.inert = inert;
    if (inert) {
      appShell.setAttribute("inert", "");
      appShell.setAttribute("aria-hidden", "true");
    } else {
      appShell.removeAttribute("inert");
      appShell.removeAttribute("aria-hidden");
    }
  }

  function showToast(title, message, isError) {
    var item = document.createElement("div");
    var icon = document.createElement("i");
    var content = document.createElement("div");
    var heading = document.createElement("strong");
    var detail = document.createElement("small");
    var closeButton = document.createElement("button");
    var closeIcon = document.createElement("i");
    var timer;

    item.className = isError ? "toast error" : "toast";
    item.setAttribute("role", isError ? "alert" : "status");
    item.setAttribute("aria-atomic", "true");
    icon.className = isError ? "ph ph-warning-circle" : "ph ph-check-circle";
    icon.setAttribute("aria-hidden", "true");
    heading.textContent = title;
    detail.textContent = message;
    content.appendChild(heading);
    content.appendChild(detail);
    closeButton.className = "btn icon-only";
    closeButton.type = "button";
    closeButton.setAttribute("aria-label", "关闭提示");
    closeIcon.className = "ph ph-x";
    closeIcon.setAttribute("aria-hidden", "true");
    closeButton.appendChild(closeIcon);
    item.appendChild(icon);
    item.appendChild(content);
    item.appendChild(closeButton);

    function removeToast() {
      if (timer) window.clearTimeout(timer);
      if (item.isConnected) item.remove();
    }

    closeButton.addEventListener("click", removeToast);
    toastStack.appendChild(item);
    timer = window.setTimeout(removeToast, 3200);
  }

  function openLayer(layer, opener) {
    if (!layer) return;
    if (!activeLayer) {
      lastFocus = opener || document.activeElement;
      previousBodyOverflow = body.style.overflow;
      previousBodyPaddingRight = body.style.paddingRight;
      var scrollbarWidth = window.innerWidth - document.documentElement.clientWidth;
      if (scrollbarWidth > 0) body.style.paddingRight = scrollbarWidth + "px";
    }
    activeLayer = layer;
    setHidden(modal, false);
    setHidden(drawer, false);
    if (layer === modal) setHidden(drawer, true);
    if (layer === drawer) setHidden(modal, true);
    setHidden(overlay, false);
    setPageInert(true);
    body.style.overflow = "hidden";
    var focusable = getFocusable(layer);
    window.requestAnimationFrame(function () {
      var target = focusable[0] || layer;
      target.focus();
    });
  }

  function closeLayer() {
    if (!activeLayer) return;
    setHidden(overlay, true);
    setHidden(modal, true);
    setHidden(drawer, true);
    setPageInert(false);
    body.style.overflow = previousBodyOverflow;
    body.style.paddingRight = previousBodyPaddingRight;
    var focusTarget = lastFocus;
    activeLayer = null;
    lastFocus = null;
    if (focusTarget && focusTarget.isConnected && !focusTarget.disabled) focusTarget.focus();
  }

  var themeToggle = document.getElementById("themeToggle");
  function setTheme(theme) {
    var normalizedTheme = theme === "dark" ? "dark" : "light";
    root.dataset.theme = normalizedTheme;
    root.style.colorScheme = normalizedTheme;
    themeToggle.setAttribute("aria-pressed", normalizedTheme === "dark" ? "true" : "false");
    themeToggle.setAttribute("aria-label", normalizedTheme === "dark" ? "切换为浅色模式" : "切换为深色模式");
    themeToggle.querySelector("span").textContent = normalizedTheme === "dark" ? "浅色模式" : "深色模式";
    var currentIcon = themeToggle.querySelector("[data-theme-icon]");
    if (currentIcon) currentIcon.className = normalizedTheme === "dark" ? "ph ph-sun" : "ph ph-moon";
    try { localStorage.setItem("tk-playground-theme", normalizedTheme); } catch (_) {}
  }

  var savedTheme = "light";
  try { savedTheme = localStorage.getItem("tk-playground-theme") || "light"; } catch (_) {}
  setTheme(savedTheme);
  themeToggle.addEventListener("click", function () {
    setTheme(root.dataset.theme === "dark" ? "light" : "dark");
  });

  document.querySelectorAll("[data-close]").forEach(function (button) {
    button.addEventListener("click", closeLayer);
  });
  overlay.addEventListener("click", function (event) {
    if (event.target === overlay) closeLayer();
  });

  document.getElementById("openModal").addEventListener("click", function () { openLayer(modal, this); });
  var drawerDescription = document.getElementById("drawerDescription");
  var drawerStatus = document.getElementById("drawerStatus");
  var drawerSync = document.getElementById("drawerSync");
  var drawerCreate = document.getElementById("drawerCreate");
  var drawerSpend = document.getElementById("drawerSpend");

  function setDrawerDetails(row) {
    if (!row) {
      drawerDescription.textContent = "双科-TTN-SG-11";
      drawerStatus.className = "badge ok";
      drawerStatus.textContent = "正常";
      drawerSync.textContent = "4 分钟前";
      drawerCreate.textContent = "可用";
      drawerSpend.textContent = "¥24,560.80";
      return;
    }

    var account = row.querySelector("td strong");
    var sync = row.querySelector(".muted");
    var status = row.querySelector(".badge");
    var numbers = row.querySelectorAll("td.num");
    drawerDescription.textContent = account ? account.textContent.trim() : "未知账户";
    drawerStatus.className = status ? status.className : "badge neutral";
    drawerStatus.textContent = status ? status.textContent.trim() : "未知";
    drawerSync.textContent = sync ? sync.textContent.replace(/^最近同步\s*/, "").trim() : "未同步";
    drawerCreate.textContent = status && status.classList.contains("bad") ? "受限" : "可用";
    drawerSpend.textContent = numbers[0] ? numbers[0].textContent.trim() : "未计算";
  }

  document.getElementById("openDrawer").addEventListener("click", function () {
    setDrawerDetails(null);
    openLayer(drawer, this);
  });
  document.querySelectorAll("[data-drawer]").forEach(function (button) {
    button.addEventListener("click", function () {
      setDrawerDetails(this.closest("tr"));
      openLayer(drawer, this);
    });
  });
  document.getElementById("confirmModal").addEventListener("click", function () {
    closeLayer();
    showToast("确认反馈已触发", "这是弹窗组件演示，未执行实际暂停操作。", false);
  });
  document.getElementById("showToast").addEventListener("click", function () {
    showToast("操作已完成", "组件状态已记录。", false);
  });
  document.getElementById("showErrorToast").addEventListener("click", function () {
    showToast("操作未完成", "连接异常，请检查账户状态。", true);
  });
  document.getElementById("saveSpec").addEventListener("click", function () {
    showToast("保存反馈已触发", "本页仅用于组件校准，不写入业务数据。", false);
  });
  document.getElementById("primaryDemo").addEventListener("click", function () {
    showToast("主按钮反馈已触发", "示例任务未进入实际队列。", false);
  });
  document.getElementById("secondaryDemo").addEventListener("click", function () {
    showToast("次要按钮反馈已触发", "示例草稿未写入业务数据。", false);
  });
  document.getElementById("dangerDemo").addEventListener("click", function () {
    showToast("删除操作未执行", "这是危险按钮的反馈示例。", true);
  });
  document.getElementById("refreshDemo").addEventListener("click", function () {
    showToast("刷新反馈已触发", "这是图标按钮的演示动作。", false);
  });
  document.getElementById("emptyAction").addEventListener("click", function () {
    showToast("创建入口反馈已触发", "未连接实际创建流程。", false);
  });

  document.querySelectorAll(".nav-item").forEach(function (button) {
    button.addEventListener("click", function () {
      document.querySelectorAll(".nav-item").forEach(function (item) {
        item.classList.remove("active");
        item.removeAttribute("aria-current");
      });
      button.classList.add("active");
      button.setAttribute("aria-current", "page");
      showToast("仅展示组件", "Playground 不连接业务页面。", false);
    });
  });

  var tabs = Array.from(document.querySelectorAll(".tab"));
  var tabPanel = document.getElementById("tab-panel");
  function activateTab(tab, moveFocus) {
    tabs.forEach(function (item) {
      var selected = item === tab;
      item.setAttribute("aria-selected", selected ? "true" : "false");
      item.tabIndex = selected ? 0 : -1;
    });
    tabPanel.setAttribute("aria-labelledby", tab.id);
    tabPanel.textContent = tab.textContent + "视图的示例内容，状态变化会在这里实时反馈。";
    if (moveFocus) tab.focus();
  }
  tabs.forEach(function (tab, index) {
    tab.addEventListener("click", function () { activateTab(tab, false); });
    tab.addEventListener("keydown", function (event) {
      if (!["ArrowRight", "ArrowLeft", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      var next = index;
      if (event.key === "ArrowRight") next = (index + 1) % tabs.length;
      if (event.key === "ArrowLeft") next = (index - 1 + tabs.length) % tabs.length;
      if (event.key === "Home") next = 0;
      if (event.key === "End") next = tabs.length - 1;
      activateTab(tabs[next], true);
    });
  });

  var dropdown = document.getElementById("statusDropdown");
  var trigger = document.getElementById("dropdownTrigger");
  var menu = document.getElementById("dropdownMenu");
  var options = Array.from(menu.querySelectorAll("[role='option']"));

  function updateOptionChecks() {
    options.forEach(function (option) {
      var checkSlot = option.querySelector(".option-check");
      while (checkSlot.firstChild) checkSlot.removeChild(checkSlot.firstChild);
      if (option.getAttribute("aria-selected") === "true") {
        var icon = document.createElement("i");
        icon.className = "ph ph-check";
        icon.setAttribute("aria-hidden", "true");
        checkSlot.appendChild(icon);
      }
    });
  }

  function focusSelectedOption(preferLast) {
    var selected = options.find(function (option) { return option.getAttribute("aria-selected") === "true"; }) || options[0];
    var target = preferLast ? options[options.length - 1] : selected;
    target.focus();
    menu.setAttribute("aria-activedescendant", target.id);
  }

  function closeDropdown(restoreFocus) {
    if (!dropdownOpen) return;
    dropdownOpen = false;
    menu.hidden = true;
    menu.setAttribute("aria-hidden", "true");
    trigger.setAttribute("aria-expanded", "false");
    trigger.removeAttribute("aria-activedescendant");
    if (restoreFocus) trigger.focus();
  }

  function openDropdown(preferLast) {
    dropdownOpen = true;
    menu.hidden = false;
    menu.setAttribute("aria-hidden", "false");
    trigger.setAttribute("aria-expanded", "true");
    window.requestAnimationFrame(function () { focusSelectedOption(preferLast); });
  }

  function chooseOption(option) {
    options.forEach(function (item) {
      item.setAttribute("aria-selected", item === option ? "true" : "false");
    });
    trigger.querySelector("span").textContent = option.dataset.label || option.textContent.trim();
    updateOptionChecks();
    closeDropdown(true);
  }

  trigger.addEventListener("click", function () {
    if (dropdownOpen) closeDropdown(false);
    else openDropdown(false);
  });
  trigger.addEventListener("keydown", function (event) {
    if (["ArrowDown", "Enter", " "].includes(event.key)) {
      event.preventDefault();
      openDropdown(false);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      openDropdown(true);
    } else if (event.key === "Escape") {
      closeDropdown(false);
    }
  });
  options.forEach(function (option, index) {
    option.tabIndex = -1;
    option.addEventListener("click", function () { chooseOption(option); });
    option.addEventListener("keydown", function (event) {
      if (event.key === "Escape") {
        event.preventDefault();
        closeDropdown(true);
        return;
      }
      if (event.key === "Tab") {
        closeDropdown(false);
        return;
      }
      if (!["ArrowDown", "ArrowUp", "Home", "End", "Enter", " "].includes(event.key)) return;
      event.preventDefault();
      if (event.key === "Enter" || event.key === " ") {
        chooseOption(option);
        return;
      }
      var next = index;
      if (event.key === "ArrowDown") next = (index + 1) % options.length;
      if (event.key === "ArrowUp") next = (index - 1 + options.length) % options.length;
      if (event.key === "Home") next = 0;
      if (event.key === "End") next = options.length - 1;
      options[next].focus();
      menu.setAttribute("aria-activedescendant", options[next].id);
    });
  });
  document.addEventListener("click", function (event) {
    if (dropdownOpen && !dropdown.contains(event.target)) closeDropdown(false);
  });
  updateOptionChecks();

  document.addEventListener("keydown", function (event) {
    if (dropdownOpen && event.key === "Escape") {
      event.preventDefault();
      closeDropdown(true);
      return;
    }
    if (!activeLayer) return;
    if (event.key === "Escape") {
      event.preventDefault();
      closeLayer();
      return;
    }
    if (event.key !== "Tab") return;
    var focusable = getFocusable(activeLayer);
    if (!focusable.length) {
      event.preventDefault();
      activeLayer.focus();
      return;
    }
    var first = focusable[0];
    var last = focusable[focusable.length - 1];
    if (!activeLayer.contains(document.activeElement)) {
      event.preventDefault();
      first.focus();
    } else if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });

  var rowChecks = Array.from(document.querySelectorAll(".row-check"));
  var selectAll = document.getElementById("selectAll");
  var selectionBar = document.getElementById("selectionBar");
  var selectionCount = document.getElementById("selectionCount");
  function updateSelection() {
    var selected = rowChecks.filter(function (check) { return check.checked; });
    selectionBar.hidden = selected.length === 0;
    selectionCount.textContent = "已选择 " + selected.length + " 项";
    selectAll.checked = selected.length === rowChecks.length;
    selectAll.indeterminate = selected.length > 0 && selected.length < rowChecks.length;
    rowChecks.forEach(function (check) {
      check.closest("tr").setAttribute("aria-selected", check.checked ? "true" : "false");
    });
  }
  rowChecks.forEach(function (check) { check.addEventListener("change", updateSelection); });
  selectAll.addEventListener("change", function () {
    rowChecks.forEach(function (check) { check.checked = selectAll.checked; });
    updateSelection();
  });
  document.getElementById("bulkPause").addEventListener("click", function () {
    showToast("暂停反馈已触发", selectionCount.textContent + "，未执行实际操作。", false);
  });
  document.getElementById("bulkExport").addEventListener("click", function () {
    showToast("导出反馈已触发", "这是组件演示，未生成实际文件。", false);
  });
  document.getElementById("applyFilter").addEventListener("click", function () {
    showToast("筛选反馈已触发", "这是组件演示，示例数据保持不变。", false);
  });
  document.getElementById("resetFilter").addEventListener("click", function () {
    document.getElementById("filterAccount").value = "";
    document.getElementById("filterStatus").selectedIndex = 0;
    document.getElementById("filterDate").selectedIndex = 0;
    showToast("筛选已重置", "已恢复默认条件。", false);
  });

  var pageButtons = Array.from(document.querySelectorAll(".page-btn[data-page]"));
  var pagePrev = document.getElementById("pagePrev");
  var pageNext = document.getElementById("pageNext");
  var pageCount = document.getElementById("pageCount");
  var currentPage = 1;
  var totalPages = pageButtons.length;
  function setPage(page) {
    currentPage = Math.max(1, Math.min(totalPages, page));
    pageButtons.forEach(function (button) {
      var selected = Number(button.dataset.page) === currentPage;
      button.classList.toggle("active", selected);
      if (selected) button.setAttribute("aria-current", "page");
      else button.removeAttribute("aria-current");
    });
    pagePrev.disabled = currentPage === 1;
    pageNext.disabled = currentPage === totalPages;
    pageCount.textContent = "共 12 个账户 · 第 " + currentPage + " 页";
  }
  pageButtons.forEach(function (button) {
    button.addEventListener("click", function () { setPage(Number(button.dataset.page)); });
  });
  pagePrev.addEventListener("click", function () { setPage(currentPage - 1); });
  pageNext.addEventListener("click", function () { setPage(currentPage + 1); });
  setPage(1);
}());
