import { ConfidentialClientApplication } from '@azure/msal-node'

const tenantId = process.env.MS_TENANT_ID!
const clientId = process.env.MS_CLIENT_ID!
const clientSecret = process.env.MS_CLIENT_SECRET!
const sender = process.env.GRAPH_SENDER! // mailbox you want to send as

if (!tenantId || !clientId || !clientSecret || !sender) {
  throw new Error('Missing Microsoft Graph env vars (MS_TENANT_ID/MS_CLIENT_ID/MS_CLIENT_SECRET/GRAPH_SENDER)')
}

const msal = new ConfidentialClientApplication({
  auth: {
    clientId,
    authority: `https://login.microsoftonline.com/${tenantId}`,
    clientSecret,
  },
})

// Simple in-memory token cache (avoids requesting a token for every email)
let cachedToken: { accessToken: string; expiresAt: number } | null = null

async function getAccessToken(): Promise<string> {
  const now = Date.now()
  if (cachedToken && cachedToken.expiresAt - 60_000 > now) {
    return cachedToken.accessToken
  }

  const result = await msal.acquireTokenByClientCredential({
    // IMPORTANT: app-only token for Graph
    scopes: ['https://graph.microsoft.com/.default'],
  })

  if (!result?.accessToken || !result.expiresOn) {
    throw new Error('Could not acquire Microsoft Graph access token')
  }

  cachedToken = {
    accessToken: result.accessToken,
    expiresAt: result.expiresOn.getTime(),
  }

  return result.accessToken
}

export async function sendEmailViaGraph(params: {
  to: string | string[]
  subject: string
  html: string
  fromName?: string
}) {
  const accessToken = await getAccessToken()

  const toList = Array.isArray(params.to) ? params.to : [params.to]

  // Graph sendMail endpoint (send as a specific mailbox):
  // POST /users/{id | userPrincipalName}/sendMail
  // Docs: user: sendMail :contentReference[oaicite:3]{index=3}
  const url = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(sender)}/sendMail`

  const body = {
    message: {
      subject: params.subject,
      body: {
        contentType: 'HTML',
        content: params.html,
      },
      toRecipients: toList.map((address) => ({
        emailAddress: { address },
      })),
    },
    saveToSentItems: true,
  }

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Graph sendMail failed: ${res.status} ${res.statusText} ${text}`)
  }
}
