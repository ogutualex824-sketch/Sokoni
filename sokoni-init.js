/* ================================================================
   SOKONI — Firebase Bootstrap Shim  (sokoni-init.js)

   Add  <script type="module" src="sokoni-init.js"></script>
   to every page that does not already load firebase.js (or a
   module that imports it, e.g. sokoni-db.js, sokoni-upload.js,
   session-manager.js).

   What this does:
   • Starts the Firebase SDK + onAuthStateChanged listener
   • Syncs Firebase Auth → localStorage (loggedIn / sokoniUser)
   • Exposes window.firebaseAuth, window.firebaseDB, window.firebaseStorage
   • Exposes window.sokoniSignOut() for all logout buttons
   • Exposes window.sokoniUpdateProfile() for profile edits
================================================================ */
import './firebase.js';
