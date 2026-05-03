import { ConfidentialClientApplication } from '@azure/msal-node'

type GraphMailerEnv = {
  tenantId: string
  clientId: string
  clientSecret: string
  sender: string
}

let msal: ConfidentialClientApplication | null = null

// Simple in-memory token cache avoids requesting a token for every email.
let cachedToken: { accessToken: string; expiresAt: number } | null = null

function getGraphMailerEnv(): GraphMailerEnv {
  const tenantId = process.env.MS_TENANT_ID
  const clientId = process.env.MS_CLIENT_ID
  const clientSecret = process.env.MS_CLIENT_SECRET
  const sender = process.env.GRAPH_SENDER

  if (!tenantId || !clientId || !clientSecret || !sender) {
    throw new Error(
      'Missing Microsoft Graph env vars (MS_TENANT_ID/MS_CLIENT_ID/MS_CLIENT_SECRET/GRAPH_SENDER)',
    )
  }

  return {
    tenantId,
    clientId,
    clientSecret,
    sender,
  }
}

function getMsalClient(): ConfidentialClientApplication {
  if (msal) return msal

  const { tenantId, clientId, clientSecret } = getGraphMailerEnv()

  msal = new ConfidentialClientApplication({
    auth: {
      clientId,
      authority: `https://login.microsoftonline.com/${tenantId}`,
      clientSecret,
    },
  })

  return msal
}

async function getAccessToken(): Promise<string> {
  const now = Date.now()

  if (cachedToken && cachedToken.expiresAt - 60_000 > now) {
    return cachedToken.accessToken
  }

  const client = getMsalClient()

  const result = await client.acquireTokenByClientCredential({
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
  const { sender } = getGraphMailerEnv()
  const accessToken = await getAccessToken()

  const toList = Array.isArray(params.to) ? params.to : [params.to]

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
