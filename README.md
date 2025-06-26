# Twilio Media Phone Emulator
A browser-based emulation tool for Twilio Media Streams that lets developers test and develop applications without physical phone devices or real Twilio phone numbers.

## Overview
This emulator allows you to connect to a media stream server directly from your browser, simulating Twilio's role in handling audio streams for phone calls.
It provides a straightforward way to test and develop Twilio-powered applications without incurring costs or requiring physical hardware.

![](/docs/preview.jpg)

### Features
* **Browser-based phone emulation:** Test calls directly from your development environment
* **Real-time audio streaming:** Connect to your Media Streams application server
* **Enhanced developer experience:** Faster development cycles with instant feedback
* **Improved audio quality:** Consistent testing environment without carrier variables
* **Detailed logging:** Track WebSocket events and media transmission in real-time
* **Team collaboration:** Multiple developers can work on the same application without sharing physical devices

### Tech Stack
* NextJS AppRouter
* ShadCN UI
* Tailwind CSS
* WebSocket for real-time communication
* [AudioWorkletProcessor](https://developer.mozilla.org/en-US/docs/Web/API/AudioWorkletProcessor) for real-time audio processing

## Getting Started
1. Clone this repository
2. Install dependencies: `npm install`
3. Start the development server: `npm run dev`
4. Open your browser to the local development URL: `http://localhost:3000`
5. Enter the webhook URL for you Twilio Twiml definition to connect to your media stream.
6. Click "Connect to call" to establish the connection

## Usage
The interface provides simple controls to:
* Connect/disconnect from your media server
* View connection status
* Monitor detailed logs of all events and transmissions

## TODO
Future enhancements to be added:
- [ ] Add muting support
- [ ] Add support for DTMF messages
- [ ] Add twilio request connection signature header

## License
This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
