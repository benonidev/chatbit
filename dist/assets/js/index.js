import { App }        from './app.js';

const pageLogin = "login";
const pageRoom = "room";
const pageLock = "lockscreen";
const pageMain = "home";

const app= new App();

window.onload = async (event) => {
    window.app = app;

    await app.init();
}