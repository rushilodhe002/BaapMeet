import { useEffect, useMemo, useRef, useState } from "react";
import { Copy, Check } from "lucide-react";
import { useParams, useNavigate } from "react-router-dom";
import VideoGrid, { GridParticipant } from "@/components/VideoGrid";
import MeetingControls from "@/components/MeetingControls";
import ChatPanel from "@/components/ChatPanel";
import ParticipantPanel from "@/components/ParticipantPanel";
import { getToken, getUser, joinMeeting, listParticipants, getChat, wsUrl, getTurn, clearAuth, testWebSocketConnectionWithFallback, endMeeting } from "@/lib/api";

const Meeting = () => {
  const { code } = useParams();
  const navigate = useNavigate();
  const [isCameraOn, setIsCameraOn] = useState(true);
  const [isMicOn, setIsMicOn] = useState(false);
  const [isScreenSharing, setIsScreenSharing] = useState(false);
  const [presenterId, setPresenterId] = useState<number | null>(null);
  const [showChat, setShowChat] = useState(false);
  const [showParticipants, setShowParticipants] = useState(false);
  const [unread, setUnread] = useState(0);
  const [audioEnabled, setAudioEnabled] = useState(true);
  const [participants, setParticipants] = useState<GridParticipant[]>([]);
  const [messages, setMessages] = useState<{id:string; sender:string; text:string; time:string; isSelf:boolean}[]>([]);
  const wsRef = useRef<WebSocket | null>(null);
  const peersRef = useRef<Map<number, RTCPeerConnection>>(new Map());
  const streamsRef = useRef<Map<number, MediaStream>>(new Map());
  const localStreamRef = useRef<MediaStream | null>(null);
  const screenStreamRef = useRef<MediaStream | null>(null);
  const participantsRef = useRef<GridParticipant[]>([]);
  const rtcServersRef = useRef<any[]>([]);
  const me = getUser();
  const [copied, setCopied] = useState(false);
  const [hostId, setHostId] = useState<number | null>(null);

  const handleCopyCode = async () => {
    try {
      const text = String(code || "");
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {}
  };

  const [showAudioGate, setShowAudioGate] = useState(false);
  // Helper: aggressively try to start all remote audio elements; show gate if blocked
  function resumeAllAudio() {
    try {
      const audios = document.querySelectorAll('audio');
      let anyBlocked = false;
      const plays: Promise<any>[] = [];
      audios.forEach((a: any) => {
        try {
          a.muted = false; a.autoplay = true;
          const p = a.play?.();
          if (p && typeof p.then === 'function') {
            plays.push(p.catch(()=>{ anyBlocked = true; }));
          }
        } catch { anyBlocked = true; }
      });
      if (plays.length) {
        Promise.allSettled(plays).then(() => { if (anyBlocked) setShowAudioGate(true); else setShowAudioGate(false); });
      } else {
        setShowAudioGate(false);
      }
    } catch { setShowAudioGate(true); }
  }

  // On mount, attempt a short retry loop to auto-start audio
  useEffect(() => {
    let tries = 0;
    const id = window.setInterval(() => {
      tries += 1;
      resumeAllAudio();
      if (tries >= 8) window.clearInterval(id);
    }, 750);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    if (!code) return;
    const token = getToken();
    if (!token) { navigate('/login'); return; }
    (async () => {
      let wsTestResult; // Declare outside try block
      try {
        // Test WebSocket connection first with fallback
        console.log("Testing WebSocket connection with fallback mechanism...");
        wsTestResult = await testWebSocketConnectionWithFallback(code);
        console.log("WebSocket test result:", wsTestResult);
        
        // Provide more specific error messages based on error codes
        if (!wsTestResult.success) {
          console.error("WebSocket connection test failed:", wsTestResult.error);
          let errorMessage = "Failed to connect to meeting server. ";
          
          // Add details if available
          if (wsTestResult.details) {
            console.log("Error details:", wsTestResult.details);
          }
          
          switch (wsTestResult.code) {
            case 1006:
              errorMessage += "The connection was closed abnormally. This usually indicates the WebSocket endpoint is not properly configured on the backend server or there's a network issue.";
              if (wsTestResult.details?.reason) {
                errorMessage += `\nDetails: ${wsTestResult.details.reason}`;
              }
              if (wsTestResult.details?.wasClean === false) {
                errorMessage += "\nThis suggests the connection was terminated unexpectedly.";
              }
              break;
            case 4401:
              errorMessage += "Authentication failed. Please log in again.";
              clearAuth(); // Clear invalid token
              break;
            case 4403:
              errorMessage += "User not found. Please contact support.";
              break;
            case 4404:
              errorMessage += "Meeting not found or has ended.";
              break;
            case 1001:
              errorMessage += "The endpoint is going away. Please try again later.";
              break;
            case 1002:
              errorMessage += "Protocol error. Please contact support.";
              break;
            case 1003:
              errorMessage += "Invalid data received. Please contact support.";
              break;
            case 1004:
              errorMessage += "Reserved. Please contact support.";
              break;
            case 1005:
              errorMessage += "No status code was actually present. Please contact support.";
              break;
            case 1007:
              errorMessage += "Invalid message data. Please contact support.";
              break;
            case 1008:
              errorMessage += "Policy violation. Please contact support.";
              break;
            case 1009:
              errorMessage += "Message too big. Please contact support.";
              break;
            case 1010:
              errorMessage += "Missing extension. Please contact support.";
              break;
            case 1011:
              errorMessage += "Internal server error. Please contact support.";
              break;
            case 1012:
              errorMessage += "Service restart. Please try again later.";
              break;
            case 1013:
              errorMessage += "Try again later. Please wait and try again.";
              break;
            case 1014:
              errorMessage += "Bad gateway. Please contact support.";
              break;
            case 1015:
              errorMessage += "TLS handshake failed. Please contact support.";
              break;
            default:
              errorMessage += "Please check your network connection and try again.";
              if (wsTestResult.details) {
                errorMessage += `\nTechnical details: ${JSON.stringify(wsTestResult.details)}`;
              }
          }
          
          alert(errorMessage);
          
          // Navigate to home for authentication issues or meeting not found
          if (wsTestResult.code === 4401 || wsTestResult.code === 4403 || wsTestResult.code === 4404) {
            navigate('/home');
          }
          return;
        }

        const join = await joinMeeting(code);
        setParticipants(join.participants.map(p => ({ id: p.id, name: p.name })));
        // assume first participant returned is host if API includes it; if not, keep null
        // backend enforces host-only on end API; hostId only controls button visibility client-side
        try { const h = (join as any).host_id; if (typeof h === 'number') setHostId(h); } catch {}
      } catch (e: any) {
        console.error("Error joining meeting:", e);
        alert(`Failed to join meeting: ${e.message || 'Unknown error'}. Please try again.`);
        navigate('/home');
        return;
      }
      // Load chat history (non-fatal if missing)
      try {
        const hist = await getChat(code);
        setMessages(hist.map(h => ({ id: String(h.id), sender: h.name, text: h.message, time: new Date(h.timestamp).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'}), isSelf: false })));
      } catch (e) { console.warn('Chat history unavailable', e); }
      // Media: constrain for stability
      const local = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 24, max: 30 } },
      });
      localStreamRef.current = local;
      // After permissions (gesture), attempt to unlock audio
      resumeAllAudio();
      setParticipants(prev => {
        const others = prev.filter(p => p.id !== (me?.id||0));
        return [{ id: me?.id||0, name: me?.name||'Me', stream: local, isSelf: true, isMuted: !isMicOn, isCameraOn }, ...others];
      });

      try { const cfg = await getTurn(); rtcServersRef.current = cfg.iceServers || []; } catch {}

      // Use the URL from the successful test
      const ws = new WebSocket(wsTestResult.url);
      wsRef.current = ws;
      
      ws.onopen = () => {
        console.log("WebSocket connection established");
        // proactive offers
        const current = participantsRef.current;
        current.forEach(p => { if (!p.isSelf && (me?.id||0) < Number(p.id)) callPeer(Number(p.id)); });
        resumeAllAudio();
      };
      
      ws.onerror = (error) => {
        console.error("WebSocket connection error:", error);
        // Display error message to user
        alert("Failed to connect to the meeting server. Please check your connection and try again.");
      };
      
      ws.onclose = (event) => {
        console.log("WebSocket connection closed:", event);
        
        // Provide specific error messages based on close codes from backend docs
        if (event.code !== 1000) { // Normal closure
          let errorMessage = "Meeting connection was lost. ";
          
          switch (event.code) {
            case 4401:
              errorMessage += "Authentication failed. Please log in again.";
              clearAuth(); // Clear invalid token
              break;
            case 4403:
              errorMessage += "User not found. Please contact support.";
              break;
            case 4404:
              errorMessage += "Meeting not found or has ended.";
              break;
            case 1006:
              errorMessage += "Network connection issue. Please check your internet connection and try again.";
              break;
            default:
              errorMessage += "Please check your connection and try again.";
          }
          
          alert(errorMessage);
          
          // Navigate to home only for authentication issues or meeting not found
          if (event.code === 4401 || event.code === 4403 || event.code === 4404) {
            navigate('/home');
          }
        }
      };
      
      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data);
          if (msg.type === 'meeting-ended') { navigate('/home'); return; }
          if (msg.type === 'user-joined' && msg.user) {
            setParticipants(prev => prev.some(p => p.id === msg.user.id) ? prev : [...prev, { id: msg.user.id, name: msg.user.name }]);
            if ((me?.id||0) < msg.user.id) {
              callPeer(msg.user.id);
            }
            resumeAllAudio();
          }
          if (msg.type === 'user-left' && msg.user) {
            setParticipants(prev => prev.filter(p => p.id !== msg.user.id));
            const pc = peersRef.current.get(msg.user.id);
            if (pc) { try { pc.close(); } catch {} peersRef.current.delete(msg.user.id); }
            streamsRef.current.delete(msg.user.id);
            if (presenterId === msg.user.id) setPresenterId(null);
          }
          if (msg.type === 'room-state') {
            const snap = Array.isArray(msg.participants) ? msg.participants : [];
            setParticipants(prev => {
              const map = new Map<number, GridParticipant>();
              [...prev, ...snap.map((p:any) => ({ id: p.id, name: p.name, isMuted: p.mic === false, isCameraOn: p.cam !== false }))].forEach(p => map.set(Number(p.id), { ...map.get(Number(p.id)), ...p } as any));
              const arr = Array.from(map.values());
              const self = arr.find(p => Number(p.id) === (me?.id||0));
              if (self && localStreamRef.current) self.stream = localStreamRef.current;
              return arr;
            });
            if (typeof msg.presenter_id === 'number') setPresenterId(msg.presenter_id);
            // Try initiating to larger-ids after snapshot
            setTimeout(() => {
              const current = participantsRef.current;
              current.forEach(p => { if (!p.isSelf && (me?.id||0) < Number(p.id)) callPeer(Number(p.id)); });
            }, 100);
          }
          if (msg.type === 'screen-share-start') {
            setPresenterId(msg.sender?.id ?? null);
          }
          if (msg.type === 'screen-share-stop') {
            if ((msg.sender?.id ?? null) === presenterId) setPresenterId(null);
          }
          if (msg.type === 'media') {
            const media = msg.data || {};
            const uid = msg.sender?.id;
            if (uid) setParticipants(prev => prev.map(p => Number(p.id) === Number(uid) ? { ...p, isMuted: media.mic === false, isCameraOn: media.cam !== false } : p));
          }
          if (msg.type === 'chat') {
            const senderId = msg.sender?.id;
            if (senderId && me && senderId === me.id) return; // ignore echo of own message
            const sender = msg.sender?.name || 'User';
            const text = msg.data?.text || '';
            const time = msg.data?.timestamp ? new Date(msg.data.timestamp).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'}) : new Date().toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'});
            setMessages(prev => [...prev, { id: String(prev.length+1), sender, text, time, isSelf: false }]);
            if (!showChat) setUnread((u) => Math.min(99, u + 1));
          }
          const to = msg.data?.to;
          if (to && me && to !== me.id) return;
          if (msg.type === 'offer') handleOffer(msg.sender.id, msg.data.sdp);
          if (msg.type === 'answer') handleAnswer(msg.sender.id, msg.data.sdp);
          if (msg.type === 'ice-candidate') handleCandidate(msg.sender.id, msg.data.candidate);
        } catch (e) {
          console.error("Error processing WebSocket message:", e);
        }
      };
    })();
    return () => { try { wsRef.current?.close(); } catch {} };
  }, [code]);

  // Ensure devices are turned off on tab close/refresh
  useEffect(() => {
    const cleanup = () => {
      try { peersRef.current.forEach((pc) => { try { pc.close(); } catch {} }); peersRef.current.clear(); } catch {}
      try { localStreamRef.current?.getTracks().forEach((t) => { try { t.stop(); } catch {} }); localStreamRef.current = null; } catch {}
      try { screenStreamRef.current?.getTracks().forEach((t) => { try { t.stop(); } catch {} }); screenStreamRef.current = null; } catch {}
      try { wsRef.current?.close(); } catch {}
    };
    window.addEventListener('beforeunload', cleanup);
    return () => window.removeEventListener('beforeunload', cleanup);
  }, []);

  const handleLeaveMeeting = () => {
    try {
      // Close peer connections
      peersRef.current.forEach((pc) => { try { pc.close(); } catch {} });
      peersRef.current.clear();
      // Stop local camera/mic
      const ls = localStreamRef.current;
      if (ls) {
        ls.getTracks().forEach((t) => {
          try { t.stop(); } catch {}
        });
      }
      localStreamRef.current = null;
      // Stop any active screen share
      const ss = screenStreamRef.current;
      if (ss) {
        ss.getTracks().forEach((t) => {
          try { t.stop(); } catch {}
        });
      }
      screenStreamRef.current = null;
      // Close websocket
      try { wsRef.current?.close(); } catch {}
      // Update UI state to reflect camera off
      setParticipants((prev) => prev.map((p) => p.isSelf ? { ...p, stream: undefined, isCameraOn: false } : p));
    } finally {
      navigate("/home");
    }
  };

  const handleEndMeeting = async () => {
    if (!code) return;
    try {
      await endMeeting(code);
      // After successful end, local cleanup and navigate home; others will get meeting-ended via WS
      handleLeaveMeeting();
    } catch (e) {
      // fallback: just navigate away
      navigate('/home');
    }
  };

  const handleSendChat = (text: string) => {
    if (!wsRef.current) return;
    wsRef.current.send(JSON.stringify({ type: 'chat', data: { text } }));
    setMessages(prev => [...prev, { id: String(prev.length+1), sender: 'You', text, time: new Date().toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'}), isSelf: true }]);
  };

  // Reset unread when opening chat
  useEffect(() => { if (showChat) setUnread(0); }, [showChat]);

  // Try to (re)start playback for all videos when participants or streams change
  useEffect(() => {
    try {
      const videos = document.querySelectorAll('video');
      videos.forEach((v: any) => v?.play?.().catch(() => {}));
    } catch {}
  }, [participants]);

  // Try to resume audio on any user gesture (autoplay policies)
  useEffect(() => {
    const resumeAudio = () => {
      try {
        const audios = document.querySelectorAll('audio');
        audios.forEach((a: any) => { try { a.muted = false; a.play?.().catch(()=>{}); } catch {} });
      } catch {}
      // one-shot unlock
      window.removeEventListener('pointerdown', resumeAudio);
      window.removeEventListener('keydown', resumeAudio);
      window.removeEventListener('click', resumeAudio);
    };
    window.addEventListener('pointerdown', resumeAudio, { once: true });
    window.addEventListener('keydown', resumeAudio, { once: true });
    window.addEventListener('click', resumeAudio, { once: true });
    return () => {
      window.removeEventListener('pointerdown', resumeAudio);
      window.removeEventListener('keydown', resumeAudio);
      window.removeEventListener('click', resumeAudio);
    };
  }, []);

  // WebRTC helpers
  function ensurePC(remoteId: number): RTCPeerConnection {
    let pc = peersRef.current.get(remoteId);
    if (pc) return pc;
    pc = new RTCPeerConnection({ iceServers: rtcServersRef.current, iceTransportPolicy: 'all' });
    // add local tracks
    const local = localStreamRef.current;
    local?.getTracks().forEach(t => pc!.addTrack(t, local));
    setTimeout(() => tunePeerSenders(pc), 0);
    pc.ontrack = (ev) => {
      // Merge tracks into a persistent MediaStream so both audio and video stay attached
      let stream: MediaStream | undefined = (ev.streams && ev.streams[0]) || streamsRef.current.get(remoteId);
      if (!stream) {
        stream = new MediaStream();
      }
      if (!stream.getTracks().includes(ev.track)) {
        try { stream.addTrack(ev.track); } catch {}
      }
      streamsRef.current.set(remoteId, stream);
      setParticipants(prev => prev.map(p => p.id === remoteId ? { ...p, stream, isCameraOn: p.isCameraOn ?? (ev.track.kind === 'video' ? true : p.isCameraOn) } : p));
      // Try to start audio as soon as any track arrives
      resumeAllAudio();
      // react to remote track state to keep UI in sync without refresh
      const tr = ev.track;
      if (tr && tr.kind === 'video') {
        tr.onmute = () => {
          setParticipants(prev => prev.map(p => p.id === remoteId ? { ...p, isCameraOn: false } : p));
        };
        tr.onunmute = () => {
          setParticipants(prev => prev.map(p => p.id === remoteId ? { ...p, isCameraOn: true } : p));
        };
        tr.onended = () => {
          setParticipants(prev => prev.map(p => p.id === remoteId ? { ...p, isCameraOn: false } : p));
        };
      }
    };
    pc.onicecandidate = (ev) => {
      if (ev.candidate) wsRef.current?.send(JSON.stringify({ type: 'ice-candidate', data: { to: remoteId, candidate: ev.candidate } }));
    };
    peersRef.current.set(remoteId, pc);
    return pc;
  }

  function tunePeerSenders(pc: RTCPeerConnection) {
    try {
      pc.getSenders().forEach((sender) => {
        const p = sender.getParameters();
        if (!p.encodings || p.encodings.length === 0) p.encodings = [{} as RTCRtpEncodingParameters];
        if (sender.track?.kind === 'video') {
          const isPresenting = presenterId === (me?.id || 0);
          const maxBitrate = isPresenting ? 1800000 : 650000;
          p.encodings[0].maxBitrate = maxBitrate;
          try { sender.setParameters(p); } catch {}
          try { (sender.track as any).contentHint = isPresenting ? 'detail' : 'motion'; } catch {}
        }
      });
    } catch {}
  }

  // keep latest participants for ws open
  useEffect(() => { participantsRef.current = participants; }, [participants]);

  async function callPeer(remoteId: number) {
    const pc = ensurePC(remoteId);
    const offer = await pc.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: true });
    await pc.setLocalDescription(offer);
    wsRef.current?.send(JSON.stringify({ type: 'offer', data: { to: remoteId, sdp: offer } }));
  }

  async function handleOffer(remoteId: number, offer: any) {
    const pc = ensurePC(remoteId);
    await pc.setRemoteDescription(offer);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    wsRef.current?.send(JSON.stringify({ type: 'answer', data: { to: remoteId, sdp: answer } }));
  }

  async function handleAnswer(remoteId: number, answer: any) {
    const pc = peersRef.current.get(remoteId);
    if (!pc) return;
    await pc.setRemoteDescription(answer);
  }

  async function handleCandidate(remoteId: number, candidate: any) {
    const pc = peersRef.current.get(remoteId);
    if (!pc || !candidate) return;
    try { await pc.addIceCandidate(candidate); } catch {}
  }

  // React to mic/camera toggles
  useEffect(() => {
    const local = localStreamRef.current;
    if (!local) return;
    local.getAudioTracks().forEach(t => t.enabled = isMicOn);
    setParticipants(prev => prev.map(p => p.isSelf ? { ...p, isMuted: !isMicOn } : p));
  }, [isMicOn]);

  useEffect(() => {
    const local = localStreamRef.current;
    if (!local) return;
    local.getVideoTracks().forEach(t => t.enabled = isCameraOn);
    setParticipants(prev => prev.map(p => p.isSelf ? { ...p, isCameraOn } : p));
  }, [isCameraOn]);

  useEffect(() => {
    async function doShare() {
      if (isScreenSharing) {
        try {
          const screen = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 24, max: 30 } }, audio: false });
          screenStreamRef.current = screen;
          const track = screen.getVideoTracks()[0];
          try { (track as any).contentHint = 'detail'; } catch {}
          peersRef.current.forEach(pc => {
            const sender = pc.getSenders().find(s => s.track && s.track.kind === 'video');
            if (sender) sender.replaceTrack(track);
            tunePeerSenders(pc);
          });
          // update local preview
          setParticipants(prev => prev.map(p => p.isSelf ? { ...p, stream: new MediaStream([track, ...(localStreamRef.current?.getAudioTracks()||[])]) } : p));
          track.onended = () => setIsScreenSharing(false);
          setPresenterId(me?.id || null);
          wsRef.current?.send(JSON.stringify({ type: 'screen-share-start', data: {} }));
        } catch { setIsScreenSharing(false); }
      } else {
        // restore camera
        const cam = localStreamRef.current?.getVideoTracks()[0];
        if (cam) {
          try { (cam as any).contentHint = 'motion'; } catch {}
          peersRef.current.forEach(pc => {
            const sender = pc.getSenders().find(s => s.track && s.track.kind === 'video');
            if (sender) sender.replaceTrack(cam);
            tunePeerSenders(pc);
          });
          setParticipants(prev => prev.map(p => p.isSelf ? { ...p, stream: localStreamRef.current || p.stream } : p));
          try { screenStreamRef.current?.getTracks().forEach(t => t.stop()); } catch {}
        }
        if (presenterId === (me?.id || null)) setPresenterId(null);
        wsRef.current?.send(JSON.stringify({ type: 'screen-share-stop', data: {} }));
      }
      // Try to keep audio alive across transitions
      resumeAllAudio();
    }
    doShare();
    // resume video playback if needed
    setTimeout(() => { try { document.querySelectorAll('video').forEach((v:any)=>v?.play?.().catch(()=>{})); } catch {} }, 0);
  }, [isScreenSharing]);

  useEffect(() => { try { peersRef.current.forEach((pc)=>tunePeerSenders(pc)); } catch {} }, [presenterId, isCameraOn]);

  // keep participants ref fresh for ws open usage
  useEffect(() => { participantsRef.current = participants; }, [participants]);

  return (
    <div className="h-screen flex flex-col bg-background">
      <header className="h-14 border-b bg-card px-6 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h1 className="font-semibold">Meeting</h1>
          <div className="flex items-center gap-2">
            <div className="px-3 py-1 bg-muted rounded-md text-sm font-mono select-all">{code}</div>
            <button
              onClick={handleCopyCode}
              title="Copy meeting code"
              className="inline-flex items-center justify-center w-7 h-7 rounded-md bg-secondary hover:bg-secondary/80 border border-border"
            >
              {copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
            </button>
          </div>
        </div>
        <div className="text-sm text-muted-foreground">
          {new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
        </div>
      </header>

      <div className="flex-1 flex overflow-hidden">
        <div className="flex-1 flex flex-col">
          <VideoGrid
            participants={participants}
            isScreenSharing={!!presenterId}
            screenShare={presenterId ? {
              stream: presenterId === (me?.id||0) ? (screenStreamRef.current || localStreamRef.current!) : (streamsRef.current.get(presenterId) || new MediaStream()),
              ownerName: participants.find(p => Number(p.id) === presenterId)?.name || 'Presenter',
              isSelf: presenterId === (me?.id||0),
              onStop: () => setIsScreenSharing(false),
            } : null}
          />
          
          <MeetingControls
            isCameraOn={isCameraOn}
            isMicOn={isMicOn}
            isScreenSharing={isScreenSharing}
            showChat={showChat}
            showParticipants={showParticipants}
            onToggleCamera={() => { const next = !isCameraOn; setIsCameraOn(next); wsRef.current?.send(JSON.stringify({ type: next ? 'camera-on' : 'camera-off', data: {} })); }}
            onToggleMic={() => { const next = !isMicOn; setIsMicOn(next); wsRef.current?.send(JSON.stringify({ type: next ? 'unmute' : 'mute', data: {} })); }}
            onToggleScreenShare={() => setIsScreenSharing(!isScreenSharing)}
            onToggleChat={() => setShowChat(!showChat)}
            onToggleParticipants={() => setShowParticipants(!showParticipants)}
            onLeaveMeeting={handleLeaveMeeting}
            isHost={hostId != null ? (me?.id === hostId) : true}
            onEndMeeting={handleEndMeeting}
            unreadCount={unread}
          />
        </div>

        {showChat && <ChatPanel onClose={() => setShowChat(false)} messages={messages} onSend={handleSendChat} />}
        {showParticipants && <ParticipantPanel onClose={() => setShowParticipants(false)} participants={participants} />}
      </div>
    </div>
  );
};

export default Meeting;
