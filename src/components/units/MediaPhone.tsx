"use client"

import {Label} from "@/components/ui/label";
import {Input} from "@/components/ui/input";
import {Badge} from "@/components/ui/badge";
import {Button} from "@/components/ui/button";
import {useCallback, useEffect, useRef, useState} from "react";

type LogEntryType = 'info' | 'error' | 'success';

type LogEntry = {
    timestamp: string;
    message: string;
    type: LogEntryType;
}

type MediaMessage = {
    sequenceNumber: number;
    media: {
        track: string;
        chunk: number;
        timestamp: number;
        payload: string; // Base64 encoded ULAW data
    };
    streamSid?: string;
}

type QueuedAudioItem = {
    audioBuffer: AudioBuffer;
    markName: string;
};

export const MediaPhone = () => {
    const [logs, setLogs] = useState<LogEntry[]>([]);
    const [url, setUrl] = useState<string>("http://localhost:5000/incoming-call");

    // Connection state
    const [isConnected, setIsConnected] = useState<boolean>(false);

    // Call management
    const isDisconnecting = useRef(false);
    const wsRef = useRef<WebSocket|null>(null);
    const audioContextRef = useRef<AudioContext | null>(null);
    const streamSidRef = useRef<string|null>(null);
    const callSidRef = useRef<string|null>(null);

    // Audio processing refs
    // Output
    const sequenceNumberRef = useRef<number>(0);
    const timestampRef = useRef<number>(0);
    // Input
    const nextStartTimeRef = useRef<number>(0);
    const audioBufferQueueRef = useRef<QueuedAudioItem[]>([]);
    const muLawDecodeTable = useRef<Int16Array|null>(null);
    const pendingMarksRef = useRef<Set<string>>(new Set());
    const currentSourceRef = useRef<AudioBufferSourceNode|null>(null);
    const pendingMarkFromServerRef = useRef<string|null>(null);
    const ulawDecoderNodeRef = useRef<AudioWorkletNode|null>(null);
    const [isPlaying, setIsPlaying] = useState<boolean>(false);

    /**
     * == UTILITY FUNCTIONS ==
     */
    const addLog = useCallback((message: string, type: LogEntryType = 'info') => {
        const timestamp = new Date().toLocaleTimeString();
        setLogs(prev => [...prev.slice(-49), {
            timestamp,
            message,
            type
        }]);
    }, []);

    const generateStreamSid = () => {
        return 'MZ' + Math.random().toString(36).substring(2, 15);
    };

    const generateCallSid = () => {
        return 'CA' + Math.random().toString(36).substring(2, 15);
    }

    const extractStreamUrlFromTwiml = (twimlXml: string) => {
        try {
            // Parse the XML to extract the Stream URL
            const parser = new DOMParser();
            const xmlDoc = parser.parseFromString(twimlXml, 'text/xml');

            // Find the Stream element and get its url attribute
            const streamElement = xmlDoc.querySelector('Stream');
            if (streamElement) {
                const streamUrl = streamElement.getAttribute('url');
                addLog(`Found stream URL in TwiML: ${streamUrl}`);
                return streamUrl;
            } else {
                addLog('No Stream element found in TwiML', 'error');
                return null;
            }
        } catch (error: any) {
            addLog(`Error parsing TwiML: ${error.message}`, 'error');
            return null;
        }
    }

    /**
     * == ULAW HANDLING FUNCS ==
     */
    const base64ToUint8Array = (base64: string): Uint8Array => {
        const binaryString = atob(base64);
        const bytes = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) {
            bytes[i] = binaryString.charCodeAt(i);
        }
        return bytes;
    };

    /**
     * == AUDIO PROCESSING ==
     */

    const clearAudioBuffer = () => {
        if (currentSourceRef.current) {
            currentSourceRef.current.stop();
            currentSourceRef.current = null;
        }

        if (ulawDecoderNodeRef.current) {
            ulawDecoderNodeRef.current.port.postMessage({
                type: 'clear'
            });
            addLog('Sent clear message to audio worklet', 'info');
        }

        pendingMarksRef.current.forEach(markName => {
            _sendMessageToClient(
                'mark',
                {
                    event: 'mark',
                    streamSid: streamSidRef.current,
                    sequenceNumber: Date.now().toString(),
                    mark: {
                        name: markName
                    }
                }
            )
        })

        audioBufferQueueRef.current = []
        pendingMarksRef.current.clear()
        nextStartTimeRef.current = audioContextRef.current ? audioContextRef.current.currentTime : 0;
        setIsPlaying(false);
    }

    const processMediaMessage = (message: MediaMessage) => {
        try {
            const muLawData = base64ToUint8Array(message.media.payload);
            
            if (ulawDecoderNodeRef.current) {
                const markName = pendingMarkFromServerRef.current;
                pendingMarkFromServerRef.current = null;
                
                // Send to decoder processor node
                ulawDecoderNodeRef.current.port.postMessage({
                    type: 'decode',
                    ulawData: muLawData,
                    markName,
                    sequenceNumber: message.sequenceNumber || message.media.chunk
                });
                addLog(`Queued ${muLawData.length} bytes in decoder worklet`, 'info');
            }
        } catch (error: any) {
            addLog(`Error processing media message: ${error.message}`, 'error');
        }
    }

    /**
     * == ./AUDIO PROCESSING ==
     */

    /**
     * Request microphone and audio permissions, and initialize the audio context.
     */
    const _initializeAudioContext = async () => {
        try {
            const stream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    sampleRate: 8000,
                    channelCount: 1,
                    echoCancellation: true,
                    noiseSuppression: true,
                    autoGainControl: true,
                }
            });

            audioContextRef.current = new AudioContext({sampleRate: 8000});

            if (audioContextRef.current.state === 'suspended') {
                await audioContextRef.current.resume();
                addLog('Audio context resumed', 'info');
            }

            await audioContextRef.current.audioWorklet.addModule('worklet/ulaw-processor.js');
            await audioContextRef.current.audioWorklet.addModule('worklet/ulaw-decoder-processor.js');
            addLog('Audio worklet processors loaded', 'info');

            const source = audioContextRef.current.createMediaStreamSource(stream)
            const encoderWorkletNode = new AudioWorkletNode(audioContextRef.current, 'ulaw-processor');

            encoderWorkletNode.port.onmessage = (event: MessageEvent) => {
                if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN && streamSidRef.current) {
                    const ulawBytes: Uint8Array = event.data;
                    const base64 = btoa(String.fromCharCode(...ulawBytes))

                    _sendMessageToClient('media', {
                        sequenceNumber: sequenceNumberRef.current++,
                        media: {
                            track: 'inbound',
                            chunk: sequenceNumberRef.current,
                            timestamp: timestampRef.current,
                            payload: base64,
                        }
                    })
                }
            }

            // Output processing decoder
            const decoderWorkletNode = new AudioWorkletNode(audioContextRef.current, 'ulaw-decoder-processor', {
                numberOfInputs: 0,
                numberOfOutputs: 1,
                outputChannelCount: [1]
            });
            ulawDecoderNodeRef.current = decoderWorkletNode;
            
            // Connect the decoder directly to the audio output
            decoderWorkletNode.connect(audioContextRef.current.destination);
            
            decoderWorkletNode.port.onmessage = (event: MessageEvent) => {
                if (event.data.type === 'bufferProcessed') {
                    const { markName } = event.data;
                    
                    if (markName) {
                        _sendMessageToClient(
                            'mark',
                            {
                                event: 'mark',
                                streamSid: streamSidRef.current,
                                sequenceNumber: Date.now().toString(),
                                mark: {
                                    name: markName
                                }
                            }
                        );
                        addLog(`Mark processed: ${markName}`, 'success');
                    }
                } else if (event.data.type === 'bufferQueued') {
                    if (event.data.queueLength > 5) {
                        addLog(`Audio queue length: ${event.data.queueLength}`, 'info');
                    }
                } else if (event.data.type === 'cleared') {
                    addLog('Audio worklet buffers cleared', 'info');
                }
            };
            
            // Connect encoder to audio output
            source.connect(encoderWorkletNode).connect(audioContextRef.current.destination);

            addLog('Audio processing pipeline set up', 'success');
            nextStartTimeRef.current = audioContextRef.current.currentTime;

            return true;
        } catch (error: any) {
            addLog(`Failed to initialize audio context: ${error.message}`, 'error');
            return false;
        }
    }

    const _getStreamDestination = async () => {
        try {
            addLog(`Initializing connection to media server at ${url}`, 'info');

            callSidRef.current = generateCallSid();

            const response = await fetch(`${url}`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                },
                // Send typical Twilio webhook parameters
                // TODO: Make these configurable inputs from the UI
                body: new URLSearchParams({
                    'CallSid': callSidRef.current,
                    'Caller': '+44234567890',
                    'Called': '+44987654321',
                    'CallStatus': 'in-progress',
                    'CallerCountry': 'UK',
                    'AccountSid': 'AC' + Math.random().toString(36).substring(2, 15),
                    'Direction': 'inbound'
                })
            });

            if (!response.ok) {
                throw new Error(`Failed to make initial connect to media server, status: ${response.status}`);
            }

            const twimlResponse = await response.text();
            addLog('Received steam connection response from media server', 'success');

            const streamUri = extractStreamUrlFromTwiml(twimlResponse);
            if (!streamUri) {
                throw new Error('No stream URL found in TwiML response');
            }

            return streamUri;
        } catch (error: any) {
            addLog(`Failed to connect to media server: ${error.message}`, 'error');
            throw error;
        }
    }

    /**
     * == WEBSOCKET CONNECTION ==
     */
    const _connectToMediaStream = async (streamUri: string) => {
        addLog(`Connecting to media stream at ${streamUri}`, 'info');

        const connectionTimeout = setTimeout(() => {
            if (wsRef.current && wsRef.current.readyState !== WebSocket.CLOSED) {
                wsRef.current.close();
                addLog('Connection timed out after 10 seconds', 'error');
            }
        }, 10000); // 10 seconds timeout for connection

        wsRef.current = new WebSocket(streamUri);

        wsRef.current.addEventListener("open", () => {
            clearTimeout(connectionTimeout);
            addLog('Media server connection established', 'success');

            // Let server know we are ready to start the call
            setTimeout(() => {
                _sendMessageToClient(
                    'connected',
                    {
                        protocol: 'Call',
                        version: '1.0.0'
                    }
                )

                _startCall();
            }, 500); // Wait a bit to ensure connection is stable
        })

        wsRef.current.addEventListener("close", (event: CloseEvent) => {
            setIsConnected(false)
        })

        wsRef.current.addEventListener("message", _handleWebSocketMessage)

        wsRef.current.addEventListener("error", (error: Event) => {
            addLog(`WebSocket error: ${error}`, 'error');
            if (wsRef.current) {
                wsRef.current.close();
            }
        })
    }

    const _handleWebSocketMessage = useCallback((event: MessageEvent) => {
        try {
            const message = JSON.parse(event.data);
            addLog(`Received ${message.event}`, 'info')

            switch (message.event) {
                case 'media':
                    processMediaMessage(message);
                    break;

                case 'mark':
                    if (!message.mark?.name) return;
                    pendingMarkFromServerRef.current = message.mark.name;
                    addLog(`Mark received: ${message.mark.name}`);
                    break;

                case 'clear':
                    addLog('Clear received - stopping audio playback');
                    clearAudioBuffer();
                    break;
            }

        } catch (error: any) {
            addLog(`Unknown message type: ${error.message}`, 'error');
        }
    }, [addLog])

    const _startCall = () => {
        if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
            addLog('WebSocket is not connected. Cannot start call.', 'error');
            return;
        }

        const streamSid = generateStreamSid();

        streamSidRef.current = streamSid;
        sequenceNumberRef.current = 0;
        timestampRef.current = 0;

        _sendMessageToClient(
            'start',
            {
                sequenceNumber: 1,
                start: {
                    streamSid: streamSidRef.current,
                    callSid: callSidRef.current,
                    tracks: ['inbound', 'outbound'],
                    mediaFormat: {
                        encoding: 'audio/x-mulaw',
                        sampleRate: 8000,
                        channels: 1
                    }
                },
                streamSid: streamSidRef.current
            }
        );
        addLog(`Sent start, streamSid: ${streamSid}`, 'info');
    }

    const _closeMediaServerConnection = (statusCode: number, statusMessage: string) => {
        if (!wsRef.current) return;

        wsRef.current.close(statusCode, statusMessage);
        wsRef.current = null;
        addLog('WebSocket connection closed', 'success');
    };

    /**
     * == ./WEBSOCKET CONNECTION ==
     */

    /**
     * Connects to the websocket server and starts a new call stream.
     */
    const _connectToCall = async () => {
        console.log('Connecting to call with URL:', url);

        if (isConnected) return;

        isDisconnecting.current = false;

        addLog('Connecting to audio devices', 'info');

        const audioContextInitialized = await _initializeAudioContext();
        if (!audioContextInitialized) {
            addLog('Failed to initialize audio context. Cannot connect to call.', 'error');
            return;
        }

        const streamUri = await _getStreamDestination();
        addLog(`Stream URI: ${streamUri}`, 'info');

        await _connectToMediaStream(streamUri);

        setIsConnected(true)

        console.log('Connect to server via HTTP/WS');
    }

    /**
     * Clean up and disconnect from the call.
     */
    const _disconnectFromCall = () => {
        console.log('Disconnecting from call');

        if (isDisconnecting.current) return;

        if (wsRef.current) {
            if (wsRef.current.readyState === WebSocket.OPEN) {
                _sendMessageToClient(
                    'stop',
                    {
                        sequenceNumber: sequenceNumberRef.current++,
                        stop: {
                            callSid: callSidRef.current
                        },
                        streamSid: streamSidRef.current
                    }
                )

                addLog(`Sent stop message to media server`, 'info');

                setTimeout(() => {
                    if (wsRef.current) {
                        _closeMediaServerConnection(1000, 'User disconnected');
                    }
                }, 100) // Wait for the message to be sent before closing
                addLog('WebSocket connection closed', 'info');
            }

            if (wsRef.current) {
                _closeMediaServerConnection(1000, 'User disconnected');
            }
        }

        ulawDecoderNodeRef.current = null;
        
        if (audioContextRef.current) {
            try {
                audioContextRef.current.close();
                audioContextRef.current = null;
                addLog('Audio context closed', 'info');
            } catch (error: any) {
                audioContextRef.current = null;
            }
        }

        isDisconnecting.current = true;
    }

    const _sendMessageToClient = (event: string, data: Record<string, any>) => {
        if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
            addLog('WebSocket is not connected. Cannot send message.', 'error');
            return;
        }

        const message = {
            event,
            ...data
        };

        wsRef.current?.send(JSON.stringify(message));
    }

    /**
     * == RENDER UI ==
     */

    useEffect(() => {
        return () => {
            isDisconnecting.current = true;
            _disconnectFromCall();
        }
    }, []);

    return (
        <>
            <div className="bg-gray-100 p-4 rounded">
                <div className="flex flex-col gap-2">
                    <Label>Connection url</Label>
                    <Input type="text" className="bg-white" placeholder="http://localhost:5000/call/connect" value={url}
                           onChange={(e) => setUrl(e.target.value)}/>
                </div>
            </div>
            <div className="bg-gray-50 flex flex-row items-center p-4 rounded mt-4 gap-2">
                <Label>Status:</Label>
                <Badge
                    variant={isConnected ? 'default' : 'secondary'}>{isConnected ? 'Connected' : 'Disconnected'}</Badge>
            </div>
            <div className="bg-gray-50 flex flex-row items-center p-4 rounded mt-4 gap-2">
                <Button onClick={() => _connectToCall()}>Connect to call</Button>
                <Button variant="secondary" onClick={() => _disconnectFromCall()}>Disconnect</Button>
            </div>

            <div className="bg-white border-1 border-gray-200 rounded mt-4">
                <div className="p-4 border-b border-gray-200">
                    <span className="text-sm font-bold">Logs</span>
                </div>
                <div className="p-4 text-sm">
                    <div className="p-4 max-h-64 overflow-y-auto">
                        {logs.length === 0 ? (
                            <p className="text-gray-500 text-sm">No logs yet...</p>
                        ) : (
                            <div className="space-y-1">
                                {logs.map((log, index) => (
                                    <div key={index} className="text-sm font-mono">
                                        <span className="text-gray-500">{log.timestamp}</span>
                                        <span className={`ml-2 ${log.type === 'error' ? 'text-red-600' :
                                            log.type === 'success' ? 'text-green-600' :
                                                'text-gray-800'
                                        }`}>
                                            {log.message}
                                        </span>
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                </div>
            </div>
        </>
    )
}
