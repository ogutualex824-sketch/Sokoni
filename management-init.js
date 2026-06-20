/**
 * SOKONI MANAGEMENT PAGE INITIALIZER
 * Shared utility for showing registration prompts on management pages
 * Use this in all management page .js files
 */

function initManagementPageAccess(roleName, pageTitle) {
  const user = safeGetJSON("sokoniUser", null);
  const hasRole = user?.registeredAs?.[roleName] === true;

  if (!hasRole) {
    showManagementAccessPrompt(roleName, pageTitle);
  }

  return hasRole;
}

function showManagementAccessPrompt(roleName, pageTitle) {
  const roleInfo = SokoniAccessControl?.ROLE_DEFINITIONS?.[roleName] || {};
  
  const prompt = document.createElement("div");
  prompt.className = "management-access-prompt";
  prompt.innerHTML = `
    <div class="prompt-wrapper">
      <div class="prompt-card">
        <div class="prompt-icon">${roleInfo.icon || '⚙️'}</div>
        <h2>Register to Start</h2>
        <p class="prompt-title">${pageTitle || 'Manage Your ' + (roleInfo.label || 'Account')}</p>
        <p class="prompt-description">${roleInfo.description || 'Set up your account to start managing your services.'}</p>
        
        <div class="prompt-features">
          <div class="feature">✅ Complete management dashboard</div>
          <div class="feature">✅ Analytics & insights</div>
          <div class="feature">✅ Customer communication</div>
          <div class="feature">✅ Payment tracking</div>
        </div>

        <div class="prompt-actions">
          <button onclick="SokoniAccessControl.registerUserRole('${roleName}'); location.reload();" class="btn-register">
            Register Now
          </button>
          <button onclick="window.history.back();" class="btn-cancel">
            Continue Browsing
          </button>
        </div>

        <p class="prompt-info">Already registered? Refresh this page.</p>
      </div>
    </div>
  `;

  // Clear current content and replace with prompt
  const body = document.body;
  const existingPrompt = document.querySelector(".management-access-prompt");
  
  if (existingPrompt) {
    existingPrompt.remove();
  }

  body.insertBefore(prompt, body.firstChild);

  // Add styles
  const style = document.createElement("style");
  style.id = "management-prompt-styles";
  if (!document.getElementById("management-prompt-styles")) {
    style.textContent = `
      .management-access-prompt {
        position: fixed;
        inset: 0;
        background: linear-gradient(135deg, #0a0e27 0%, #1a1a2e 100%);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 5000;
        padding: 20px;
        min-height: 100vh;
      }

      .prompt-wrapper {
        width: 100%;
        max-width: 480px;
      }

      .prompt-card {
        background: #1a1a1a;
        border: 2px solid rgba(113, 255, 0, 0.2);
        border-radius: 16px;
        padding: 50px 40px;
        text-align: center;
        box-shadow: 0 20px 60px rgba(0, 0, 0, 0.5);
        animation: slideInUp 0.4s cubic-bezier(0.34, 1.56, 0.64, 1);
      }

      @keyframes slideInUp {
        from {
          transform: translateY(30px);
          opacity: 0;
        }
        to {
          transform: translateY(0);
          opacity: 1;
        }
      }

      .prompt-icon {
        font-size: 64px;
        margin-bottom: 24px;
        display: block;
      }

      .prompt-card h2 {
        font-size: 28px;
        color: #71ff00;
        margin: 0 0 8px 0;
        font-weight: 800;
      }

      .prompt-title {
        font-size: 16px;
        color: #fff;
        margin: 0 0 12px 0;
        font-weight: 600;
      }

      .prompt-description {
        font-size: 14px;
        color: #aaa;
        margin: 0 0 28px 0;
        line-height: 1.6;
      }

      .prompt-features {
        background: rgba(113, 255, 0, 0.05);
        border-left: 3px solid #71ff00;
        border-radius: 8px;
        padding: 20px;
        margin: 0 0 28px 0;
        text-align: left;
      }

      .feature {
        padding: 8px 0;
        color: #bbb;
        font-size: 14px;
        line-height: 1.4;
      }

      .feature:before {
        content: "✓ ";
        color: #71ff00;
        font-weight: 700;
        margin-right: 8px;
      }

      .prompt-actions {
        display: flex;
        flex-direction: column;
        gap: 12px;
        margin-bottom: 20px;
      }

      .btn-register,
      .btn-cancel {
        padding: 14px 24px;
        border: none;
        border-radius: 8px;
        font-size: 15px;
        font-weight: 700;
        cursor: pointer;
        transition: all 0.3s;
        font-family: inherit;
      }

      .btn-register {
        background: #71ff00;
        color: #000;
      }

      .btn-register:hover {
        background: #8aff1a;
        transform: translateY(-2px);
        box-shadow: 0 8px 20px rgba(113, 255, 0, 0.3);
      }

      .btn-cancel {
        background: transparent;
        border: 1px solid rgba(113, 255, 0, 0.3);
        color: #71ff00;
      }

      .btn-cancel:hover {
        background: rgba(113, 255, 0, 0.1);
        border-color: rgba(113, 255, 0, 0.6);
      }

      .prompt-info {
        font-size: 12px;
        color: #666;
        margin: 0;
      }

      @media (max-width: 520px) {
        .prompt-card {
          padding: 40px 24px;
        }

        .prompt-card h2 {
          font-size: 24px;
        }

        .prompt-title {
          font-size: 15px;
        }

        .prompt-actions {
          flex-direction: column;
        }

        .btn-register,
        .btn-cancel {
          width: 100%;
        }
      }
    `;
    document.head.appendChild(style);
  }
}
