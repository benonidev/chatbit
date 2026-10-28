import {Modals} from "./modal.js";
import {logger} from "./log.js";

const log = logger("scanner");

// Local copy of the zxing-cpp WebAssembly decoder (used by the BarcodeDetector polyfill)
const ZXING_WASM_URL = "assets/js/lib/zxing/zxing_reader-2.2.4.wasm";

// Scans room invite QR codes in the join modal.
// Uses the native BarcodeDetector where it exists (Chrome/Android/Edge) and otherwise the
// BarcodeDetector polyfill from lib/zxing (zxing-cpp compiled to WebAssembly, e.g. on iOS
// Safari and Firefox). Both share the same API, so there is only one scan path.
//
// The camera runs only while the join modal is visible: it is started on "shown.bs.modal"
// and stopped on "hidden.bs.modal", so it is released no matter how the modal is closed
// (close button, backdrop, escape, joining by invite code or a successful scan).
export class QRScanner {
    constructor() {
        this._stream = null;    // MediaStream of the running camera
        this._detector = null;  // BarcodeDetector (native or polyfill), created once
        this._session = 0;      // incremented on every stop, invalidates running async starts
    }

    // Registers the camera handling for the next time the join modal is shown.
    // onScan(rawValue) is called once with the content of the first QR code found.
    Start(onScan) {
        const modal = document.getElementById(Modals.HOME.JOIN_ROOM);
        if (!modal) return;

        modal.addEventListener("shown.bs.modal", () => this._startCamera(onScan), { once: true });
        modal.addEventListener("hidden.bs.modal", () => this.Stop(), { once: true });
    }

    // Stops the camera and all running scans.
    Stop() {
        this._session++;

        if (this._stream) {
            this._stream.getTracks().forEach(t => t.stop());
            this._stream = null;
        }

        const video = document.getElementById("reader-video");
        if (video) video.srcObject = null;

        const select = document.getElementById("camera-select");
        if (select) select.onchange = null;
    }

    async _startCamera(onScan) {
        const session = this._session;

        // Stops the camera and reports the QR code — only for the first code of this session
        const found = (rawValue) => {
            if (session !== this._session) return;
            this.Stop();
            onScan(rawValue);
        };

        try {
            await this._scan(session, found);
        } catch (err) {
            if (session !== this._session) return; // modal was closed meanwhile

            // Keep the modal open — joining by invite code still works without a camera
            if (err.name === "NotAllowedError") {
                alert("Camera access denied. You can still join with an invite code.");
            } else {
                log.error("camera error:", err);
            }
            this.Stop();
        }
    }

    // Native BarcodeDetector if it supports QR codes, the zxing-wasm polyfill otherwise.
    // iOS: Safari has no BarcodeDetector, and where a WebKit build exposes one it is unreliable.
    async _getDetector() {
        if (this._detector) return this._detector;

        const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent)
            || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1); // iPadOS
        let useNative = false;
        if ("BarcodeDetector" in window && !isIOS) {
            try {
                useNative = (await BarcodeDetector.getSupportedFormats()).includes("qr_code");
            } catch {
                useNative = false;
            }
        }

        if (useNative) {
            this._detector = new BarcodeDetector({ formats: ["qr_code"] });
        } else {
            const api = window.BarcodeDetectionAPI;
            // Load the WebAssembly file from our server instead of the CDN (offline / PWA cache)
            api.prepareZXingModule({
                overrides: {
                    locateFile: (path, prefix) => path.endsWith(".wasm")
                        ? new URL(ZXING_WASM_URL, document.baseURI).href
                        : prefix + path,
                },
                fireImmediately: true, // start loading the 1 MB wasm while the camera starts
            });
            this._detector = new api.BarcodeDetector({ formats: ["qr_code"] });
        }
        return this._detector;
    }

    async _scan(session, found) {
        const select = document.getElementById("camera-select");
        const video = document.getElementById("reader-video");

        const detector = await this._getDetector();
        if (session !== this._session) return;

        const startStream = async (deviceId) => {
            if (this._stream) this._stream.getTracks().forEach(t => t.stop());
            // Without an explicit size iOS delivers only 640x480, too coarse for small QR codes.
            // "ideal" falls back to the best resolution the camera supports.
            const constraints = {
                video: {
                    ...(deviceId ? { deviceId: { exact: deviceId } } : { facingMode: "environment" }),
                    width: { ideal: 1920 },
                    height: { ideal: 1080 },
                },
                audio: false,
            };
            const stream = await navigator.mediaDevices.getUserMedia(constraints);

            // The modal was closed while waiting for camera permission
            if (session !== this._session) {
                stream.getTracks().forEach(t => t.stop());
                return;
            }

            this._stream = stream;
            video.srcObject = stream;
            video.play().catch(() => {}); // playsinline + muted allow autoplay on iOS

            // Continuous autofocus where supported (Android); iOS has no focus constraints
            const track = stream.getVideoTracks()[0];
            const caps = track.getCapabilities ? track.getCapabilities() : {};
            if (caps.focusMode && caps.focusMode.includes("continuous")) {
                track.applyConstraints({ advanced: [{ focusMode: "continuous" }] }).catch(() => {});
            }
        };

        await startStream();
        if (session !== this._session) return;

        // Labels are only available after the permission was granted, i.e. after getUserMedia
        const devices = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === "videoinput");
        if (session !== this._session) return;
        const activeId = this._stream.getVideoTracks()[0].getSettings().deviceId;
        select.innerHTML = devices.map((d, i) =>
            `<option value="${d.deviceId}">${d.label || "Camera " + (i + 1)}</option>`
        ).join("");
        if (activeId) select.value = activeId;
        select.onchange = () => startStream(select.value).catch(err => log.error("camera error:", err));

        // Detect directly on the video element. Until a frame is available detect() fails
        // or finds nothing, and the loop simply tries again.
        const scan = () => {
            if (session !== this._session) return;
            if (!this._stream || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
                setTimeout(scan, 100);
                return;
            }
            detector.detect(video).then(codes => {
                if (codes.length > 0) {
                    found(codes[0].rawValue);
                    return;
                }
                setTimeout(scan, 50);
            }).catch(() => setTimeout(scan, 100));
        };
        scan();
    }
}
