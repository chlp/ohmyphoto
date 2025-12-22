/**
 * Verify Cloudflare Turnstile token
 * @param {string} token - Turnstile token from client
 * @param {string} secretKey - Turnstile secret key from env
 * @param {string} remoteip - Optional client IP
 * @param {number} timeoutMs - Abort verification request after this timeout (ms)
 * @returns {Promise<{success: boolean, error?: string}>}
 */
export async function verifyTurnstileToken(token, secretKey, remoteip = null, timeoutMs = 5000) {
  if (!token || !secretKey) {
    return { success: false, error: 'Missing token or secret key' };
  }

  const formData = new FormData();
  formData.append('secret', secretKey);
  formData.append('response', token);
  if (remoteip) {
    formData.append('remoteip', remoteip);
  }

  try {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(new Error('Turnstile verification timeout')), Number(timeoutMs) || 5000);
    const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      body: formData,
      signal: ac.signal
    }).finally(() => clearTimeout(t));

    const result = await response.json();
    
    if (result.success) {
      return { success: true };
    } else {
      return { 
        success: false, 
        error: result['error-codes']?.join(', ') || 'Turnstile verification failed' 
      };
    }
  } catch (error) {
    return { 
      success: false, 
      error: `Turnstile verification error: ${error.message}` 
    };
  }
}

