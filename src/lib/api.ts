export const BASE_API = "https://3-229-124-73.nip.io";

export interface User { id: number; name: string; email: string; created_at: string; }
export interface Participant { id: number; name: string; }
export interface ChatMessage { id: number; user_id: number; name: string; message: string; timestamp: string; }

export function getToken(): string | null { return localStorage.getItem('token'); }
export function setToken(t: string) { localStorage.setItem('token', t); }
export function setUser(u: User) { localStorage.setItem('user', JSON.stringify(u)); }
export function getUser(): User | null { try { return JSON.parse(localStorage.getItem('user')||'null'); } catch { return null; } }
export function clearAuth() { localStorage.removeItem('token'); localStorage.removeItem('user'); }

async function request<T>(path: string, opts: RequestInit = {}, auth = true): Promise<T> {
  const headers = new Headers(opts.headers);
  if (!headers.has('Content-Type') && opts.body && !(opts.body instanceof FormData)) headers.set('Content-Type','application/json');
  if (auth) {
    const t = getToken(); if (t) headers.set('Authorization', `Bearer ${t}`);
  }
  const res = await fetch(`${BASE_API}${path}`, { ...opts, headers });
  if (!res.ok) { const text = await res.text(); let msg = text; try { const j = JSON.parse(text); msg = (j as any).detail || (j as any).message || text; } catch {} throw new Error(msg || res.statusText); }
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('application/json')) return res.json();
  return (await res.text()) as any;
}

export async function signup(name: string, email: string, password: string) {
  const data = await request<{ token: string }>(`/auth/signup`, { method: 'POST', body: JSON.stringify({ name, email, password }) }, false);
  setToken(data.token);
  const profile = await request<User>(`/user/profile`);
  setUser(profile);
  return profile;
}

export async function login(email: string, password: string) {
  const data = await request<{ token: string; user: User }>(`/auth/login`, { method: 'POST', body: JSON.stringify({ email, password }) }, false);
  setToken(data.token);
  setUser(data.user);
  return data.user;
}

export async function createMeeting(title?: string) {
  return request<{ meeting_id: string; join_url: string }>(`/meeting/create`, { method: 'POST', body: JSON.stringify({ title: title || null }) });
}

export async function joinMeeting(meeting_id: string) {
  return request<{ message: string; participants: Participant[] }>(`/meeting/join`, { method: 'POST', body: JSON.stringify({ meeting_id }) });
}

export async function listParticipants(meeting_id: string) {
  return request<Participant[]>(`/meeting/${meeting_id}/participants`);
}

export async function getChat(meeting_id: string) {
  const res = await request<any>(`/meeting/${meeting_id}/chat`);
  return Array.isArray(res) ? (res as ChatMessage[]) : [];
}

export async function getTurn() { return request<{ iceServers: any[] }>(`/config/turn`); }

export async function endMeeting(meeting_id: string) {
  return request<{ message: string }>(`/meeting/end`, { method: 'POST', body: JSON.stringify({ meeting_id }) });
}

export function wsUrl(meeting_id: string, includeToken: boolean = true): string {
  const t = getToken();
  // Log the WebSocket URL for debugging
  console.log("Generating WebSocket URL for meeting:", meeting_id);
  console.log("Token available:", !!t);
  console.log("Include token:", includeToken);
  
  // According to backend docs, token is required for authentication
  if (!t && includeToken) {
    console.warn("No token available for WebSocket connection - this will likely fail");
  }
  
  // Check if we're using HTTPS and adjust WebSocket protocol accordingly
  let wsProtocol = 'ws';
  if (BASE_API.startsWith('https://')) {
    wsProtocol = 'wss';
  }
  
  const baseUrl = BASE_API.replace(/^https?:\/\//, '');
  // Backend docs specify token should be in query parameter
  const tokenParam = includeToken && t ? `token=${encodeURIComponent(t)}` : '';
  const separator = tokenParam ? '?' : '';
  const wsUrl = `${wsProtocol}://${baseUrl}/ws/meetings/${encodeURIComponent(meeting_id)}${separator}${tokenParam}`;
  console.log("Generated WebSocket URL:", wsUrl);
  return wsUrl;
}

// Add a function to test WebSocket connection with detailed error info
export function testWebSocketConnection(url: string): Promise<{success: boolean, error?: string, code?: number, details?: any}> {
  return new Promise((resolve) => {
    console.log("Testing WebSocket connection to:", url);
    
    // Check if we're on a secure context
    console.log("Secure context:", window.isSecureContext);
    
    // Check if the URL is properly formatted
    try {
      const parsedUrl = new URL(url);
      console.log("WebSocket URL is valid");
      console.log("Protocol:", parsedUrl.protocol);
      console.log("Host:", parsedUrl.host);
      console.log("Pathname:", parsedUrl.pathname);
      console.log("Search params:", parsedUrl.search);
    } catch (e) {
      console.error("Invalid WebSocket URL:", url);
      resolve({success: false, error: "Invalid WebSocket URL"});
      return;
    }
    
    const ws = new WebSocket(url);
    
    // Log WebSocket events for debugging
    console.log("WebSocket object created:", ws);
    console.log("WebSocket readyState:", ws.readyState);
    
    const timeout = setTimeout(() => {
      ws.close();
      resolve({success: false, error: "Connection timeout - server may be unreachable", code: 1006});
    }, 15000); // Increased timeout to 15 seconds
    
    ws.onopen = () => {
      clearTimeout(timeout);
      console.log("WebSocket connection test successful");
      console.log("WebSocket readyState after open:", ws.readyState);
      // Keep connection open briefly to test stability
      setTimeout(() => {
        ws.close();
        resolve({success: true});
      }, 1000);
    };
    
    ws.onerror = (error) => {
      clearTimeout(timeout);
      console.error("WebSocket connection test failed with error:", error);
      console.log("WebSocket readyState after error:", ws.readyState);
      
      // Try to get more details about the error
      try {
        // @ts-ignore
        console.log("Error details:", error?.message || error);
        resolve({success: false, error: "Connection failed - check network and server status", code: 1006, details: error});
      } catch (e) {
        console.log("Unable to get detailed error information");
        resolve({success: false, error: "Connection failed - check network and server status", code: 1006});
      }
    };
    
    ws.onclose = (event) => {
      clearTimeout(timeout);
      console.log("WebSocket test connection closed:", event.code, event.reason);
      console.log("WebSocket readyState after close:", ws.readyState);
      
      // Handle specific close codes from backend documentation
      switch (event.code) {
        case 4401:
          resolve({success: false, error: "Authentication failed - invalid or missing token", code: event.code});
          break;
        case 4403:
          resolve({success: false, error: "User not found", code: event.code});
          break;
        case 4404:
          resolve({success: false, error: "Meeting not found or already ended", code: event.code});
          break;
        case 1006:
          resolve({success: false, error: "Abnormal closure - network issues or server problems", code: event.code, details: {reason: event.reason, wasClean: event.wasClean}});
          break;
        case 1000:
        case 1005:
          // Normal closure during testing
          resolve({success: true});
          break;
        default:
          resolve({success: false, error: `Connection closed with code ${event.code}: ${event.reason || 'Unknown reason'}`, code: event.code});
      }
    };
  });
}

// Add a function to test WebSocket connection with and without token
export async function testWebSocketConnectionWithFallback(meeting_id: string): Promise<{url: string, success: boolean, error?: string, code?: number, details?: any}> {
  // First try with token
  const urlWithToken = wsUrl(meeting_id, true);
  console.log("Testing WebSocket connection with token...");
  const resultWithToken = await testWebSocketConnection(urlWithToken);
  
  if (resultWithToken.success) {
    return {url: urlWithToken, success: true};
  }
  
  // Log the specific error for debugging
  console.log("Connection with token failed:", resultWithToken.error, "Code:", resultWithToken.code);
  if (resultWithToken.details) {
    console.log("Connection with token details:", resultWithToken.details);
  }
  
  // If that fails, try without token
  console.log("Testing WebSocket connection without token...");
  const urlWithoutToken = wsUrl(meeting_id, false);
  const resultWithoutToken = await testWebSocketConnection(urlWithoutToken);
  
  if (resultWithoutToken.success) {
    return {url: urlWithoutToken, success: true};
  }
  
  // Log the specific error for debugging
  console.log("Connection without token failed:", resultWithoutToken.error, "Code:", resultWithoutToken.code);
  if (resultWithoutToken.details) {
    console.log("Connection without token details:", resultWithoutToken.details);
  }
  
  // Both failed
  return {
    url: urlWithToken, 
    success: false, 
    error: resultWithToken.error || resultWithoutToken.error || "Connection failed",
    code: resultWithToken.code || resultWithoutToken.code,
    details: resultWithToken.details || resultWithoutToken.details
  };
}
