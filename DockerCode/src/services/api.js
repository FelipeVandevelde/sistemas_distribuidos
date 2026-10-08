const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL || "").replace(/\/$/, "");

function apiUrl(path) {
  return `${API_BASE_URL}${path}`;
}

async function parseError(response) {
  try {
    const body = await response.json();
    return body?.message || body?.detail || body?.error || `Erro HTTP ${response.status}`;
  } catch {
    return `Erro HTTP ${response.status}`;
  }
}

export async function submitJob(payload, signal) {
  let response;

  try {
    response = await fetch(apiUrl("/api/jobs"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
      signal,
    });
  } catch (error) {
    if (error?.name === "AbortError") throw error;
    throw new Error("Não foi possível conectar à API.");
  }

  if (!response.ok) {
    throw new Error(await parseError(response));
  }

  return response.json();
}

export async function getJob(jobId, signal) {
  let response;

  try {
    response = await fetch(apiUrl(`/api/jobs/${encodeURIComponent(jobId)}`), {
      method: "GET",
      headers: {
        Accept: "application/json",
      },
      signal,
    });
  } catch (error) {
    if (error?.name === "AbortError") throw error;
    throw new Error("Não foi possível consultar o estado da execução.");
  }

  if (!response.ok) {
    throw new Error(await parseError(response));
  }

  return response.json();
}

export function isTerminalStatus(status) {
  return ["SUCCEEDED", "FAILED", "TIMEOUT"].includes(status);
}

export function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    const timeoutId = window.setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);

    function onAbort() {
      window.clearTimeout(timeoutId);
      reject(new DOMException("Operação cancelada", "AbortError"));
    }

    if (signal?.aborted) {
      onAbort();
      return;
    }

    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
