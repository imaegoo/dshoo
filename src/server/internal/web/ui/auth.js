"use strict";

/* Shared submit logic for the setup and login forms. Which endpoint is used is
   decided by the page, not by the user. */

(function () {
  const form = document.querySelector("form[data-endpoint]");
  if (form === null) return;

  const endpoint = form.dataset.endpoint;
  const alertBox = document.getElementById("alert");
  const submit = form.querySelector("button[type=submit]");
  const confirmField = form.querySelector("[data-confirm]");

  function fail(message) {
    alertBox.textContent = message;
    alertBox.classList.add("show");
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    alertBox.classList.remove("show");

    const data = Object.fromEntries(new FormData(form).entries());
    if (confirmField !== null && data.confirm !== data.password) {
      fail("两次输入的密码不一致");
      return;
    }

    submit.disabled = true;
    const label = submit.textContent;
    submit.textContent = "请稍候…";
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", "x-requested-with": "dshoo" },
        body: JSON.stringify({ username: data.username, password: data.password }),
      });
      if (response.ok) {
        location.replace("/");
        return;
      }
      const body = await response.json().catch(() => ({}));
      fail(body.error || (response.status === 429 ? "尝试次数过多，请稍后再试" : "操作失败"));
    } catch {
      fail("无法连接到服务器");
    } finally {
      submit.disabled = false;
      submit.textContent = label;
    }
  });
})();
