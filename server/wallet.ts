import type { Express } from "express";
import { db } from "../db";
import { wallets, transactions, users } from "@db/schema";
import axios from 'axios';
import { eq, and, or } from "drizzle-orm";
import { ethers } from "ethers";
import { WebSocket, WebSocketServer } from 'ws';

// Price feed
let avaxUsdPrice = 0;
async function updateAvaxPrice() {
  try {
    const response = await axios.get('https://api.coingecko.com/api/v3/simple/price?ids=avalanche-2&vs_currencies=usd');
    avaxUsdPrice = response.data['avalanche-2'].usd;
  } catch (error) {
    console.error('Failed to fetch AVAX price:', error);
  }
}

// Update price every 5 minutes
setInterval(updateAvaxPrice, 5 * 60 * 1000);
// Initial price fetch
updateAvaxPrice();
const FUJI_RPC_URL = "https://api.avax-test.network/ext/bc/C/rpc";
let provider: ethers.JsonRpcProvider;

// Type definitions
interface ExtendedRequest extends Express.Request {
  session: {
    passport?: {
      user?: number;
    };
  } & Express.Request['session'];
}

interface TransactionReceipt {
  blockNumber: number;
  gasUsed: bigint;
  status: number;
}

interface CustomTransactionReceipt {
  blockNumber: number;
  gasUsed: bigint;
  status: number;
  hash: string;
}

// WebSocket setup
const wss = new WebSocketServer({ noServer: true });
const clients = new Map<number, WebSocket>();

// WebSocket upgrade handling
export function handleUpgrade(server: any) {
  server.on('upgrade', (request: any, socket: any, head: any) => {
    const extendedRequest = request as ExtendedRequest;
    if (!extendedRequest.session?.passport?.user) {
      socket.destroy();
      return;
    }
    
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, extendedRequest);
    });
  });
}

// WebSocket connection handling
wss.on('connection', (ws, request: ExtendedRequest) => {
  const userId = request.session?.passport?.user;
  if (userId) {
    clients.set(userId, ws);
    
    ws.on('close', () => {
      clients.delete(userId);
    });
  }
});

// Type guard for user authentication
function isAuthenticated(req: Express.Request): req is Express.Request & { user: Express.User } {
  return req.isAuthenticated() && req.user !== undefined && typeof req.user.id === 'number';
}

try {
  provider = new ethers.JsonRpcProvider(FUJI_RPC_URL);
} catch (error) {
  console.error("Failed to initialize Avalanche Fuji provider:", error);
  provider = new ethers.JsonRpcProvider(FUJI_RPC_URL);
}

// Function to request test AVAX from faucet
async function requestTestAVAX(address: string): Promise<boolean> {
  try {
    // Check current balance
    const balance = await provider.getBalance(address);
    const balanceInAvax = Number(ethers.formatEther(balance));
    
    // Only request if balance is below 0.1 AVAX
    if (balanceInAvax < 0.1) {
      console.log(`Low balance (${balanceInAvax} AVAX) detected for ${address}, requesting from faucet...`);
      
      // Make request to Avalanche Fuji Testnet Faucet
      const response = await axios.post('https://faucet.avax-test.network/api/v1/drip', {
        address,
        chain: 'fuji'
      });
      
      if (response.status === 200) {
        console.log(`Successfully requested test AVAX for ${address}`);
        return true;
      }
    }
    
    return false;
  } catch (error) {
    console.error("Failed to request test AVAX:", error);
    return false;
  }
}

// Function to estimate transaction fees
async function estimateTransactionFees(from: string, to: string, amount: string): Promise<{
  gasLimit: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  totalFees: bigint;
}> {
  // Get current gas price and fee data
  const feeData = await provider.getFeeData();
  if (!feeData.maxFeePerGas || !feeData.maxPriorityFeePerGas) {
    throw new Error("Failed to fetch gas prices");
  }

  // Estimate gas
  const gasEstimate = await provider.estimateGas({
    from,
    to,
    value: ethers.parseEther(amount)
  });

  // Add 20% buffer to gas estimate
  const gasLimit = gasEstimate * BigInt(120) / BigInt(100);
  
  // Calculate total fees
  const totalFees = gasLimit * feeData.maxFeePerGas;

  return {
    gasLimit,
    maxFeePerGas: feeData.maxFeePerGas,
    maxPriorityFeePerGas: feeData.maxPriorityFeePerGas,
    totalFees
  };
}

export function setupWallet(app: Express) {
  // Middleware to ensure user is authenticated
  const requireAuth = (
    req: Express.Request,
    res: Express.Response,
    next: (err?: any) => void
  ) => {
    if (!isAuthenticated(req)) {
      return res.status(401).send("Not authenticated");
    }
    next();
  };

  // Balance polling service
  const pollBalances = async () => {
    try {
      const allWallets = await db.select().from(wallets);
      
      for (const wallet of allWallets) {
        try {
          const balance = await provider.getBalance(wallet.address);
          const formattedBalance = ethers.formatEther(balance);
          
          // Update database if balance changed
          if (formattedBalance !== wallet.balance) {
            console.log(`Balance changed for wallet ${wallet.address}:`, {
              oldBalance: wallet.balance,
              newBalance: formattedBalance,
              change: Number(formattedBalance) - Number(wallet.balance)
            });

            await db
              .update(wallets)
              .set({ balance: formattedBalance })
              .where(eq(wallets.id, wallet.id));

            // Notify connected client if exists
            const client = clients.get(wallet.userId);
            if (client && client.readyState === WebSocket.OPEN) {
              client.send(JSON.stringify({
                type: 'BALANCE_UPDATE',
                walletId: wallet.id,
                balance: formattedBalance,
                timestamp: new Date().toISOString()
              }));
            }
          }
        } catch (walletError) {
          console.error(`Error polling balance for wallet ${wallet.address}:`, walletError);
          continue; // Continue with next wallet if one fails
        }
      }
    } catch (error) {
      console.error('Error in balance polling service:', error);
      throw error; // Rethrow for global error handler
    }
  };

  // Start polling every 10 seconds
  setInterval(pollBalances, 10000);

  // Initial balance poll
  pollBalances().catch(error => {
    console.error('Error in initial balance poll:', error);
  });

  // Create new wallet
  app.post("/api/wallets", requireAuth, async (req, res) => {

    try {
      const { name, type } = req.body;

      if (!name || !type || !["personal", "emergency", "investments"].includes(type)) {
        return res.status(400).send("Invalid wallet type. Must be one of: personal, emergency, investments");
      }

      // Create new Fuji testnet wallet
      const wallet = ethers.Wallet.createRandom().connect(provider);
      
      // Log wallet creation (safely)
      console.log(`Created new wallet for user ${req.user.id}:`, {
        address: wallet.address,
        type,
        timestamp: new Date().toISOString()
      });

      // Request test AVAX from faucet
      const faucetSuccess = await requestTestAVAX(wallet.address);
      if (!faucetSuccess) {
        console.warn(`Failed to request test AVAX for wallet: ${wallet.address}`);
      }

      // Check initial balance
      const balance = await provider.getBalance(wallet.address);
      
      // Save wallet to database
      await db.insert(wallets).values({
        userId: req.user.id,
        name,
        type,
        address: wallet.address,
        privateKey: wallet.privateKey,
        balance: ethers.formatEther(balance),
      });

      res.json({ 
        success: true,
        address: wallet.address,
        balance: ethers.formatEther(balance)
      });
    } catch (error: any) {
      console.error("Error creating wallet:", error);
      res.status(500).send("Failed to create wallet");
    }
  });

  // Get user's wallets
  app.get("/api/wallets", requireAuth, async (req, res) => {
    if (!req.user?.id) {
      return res.status(401).send("User session invalid");
    }

    try {
      const userWallets = await db.select()
        .from(wallets)
        .where(eq(wallets.userId, req.user.id));
      
      // Update balances from blockchain
      for (const wallet of userWallets) {
        const balance = await provider.getBalance(wallet.address);
        await db.update(wallets)
          .set({ balance: ethers.formatEther(balance) })
          .where(eq(wallets.id, wallet.id));
      }

      const walletsWithUsd = userWallets.map(wallet => ({
        ...wallet,
        usdBalance: (Number(wallet.balance) * avaxUsdPrice).toString()
      }));
      res.json(walletsWithUsd);
    } catch (error: any) {
      res.status(500).send(error.message);
    }
  });

  // Get user's transactions
  app.get("/api/transactions", requireAuth, async (req, res) => {
    try {
      const userTransactions = await db.select()
        .from(transactions)
        .where(
          or(
            eq(transactions.fromUserId, req.user.id),
            eq(transactions.toUserId, req.user.id)
          )
        );
      res.json(userTransactions);
    } catch (error: any) {
      res.status(500).send(error.message);
    }
  });

  // Send money
  app.post("/api/transactions/send", requireAuth, async (req, res) => {
    if (!req.user?.id) {
      return res.status(401).send("User session invalid");
    }

    const { recipient, amount, note, useAddress, walletId } = req.body;

    if (!walletId) {
      return res.status(400).send("Wallet ID is required");
    }

    try {
      // Get sender's wallet using walletId from request
      const [senderWallet] = await db.select()
        .from(wallets)
        .where(and(
          eq(wallets.userId, req.user.id),
          eq(wallets.id, walletId)
        ))
        .limit(1);

      if (!senderWallet) {
        return res.status(400).send("Selected wallet not found");
      }

      let recipientAddress: string;
      let recipientUserId: number | null = null;

      if (useAddress) {
        // Validate the recipient address format
        if (!ethers.isAddress(recipient)) {
          return res.status(400).send("Invalid recipient address format");
        }
        recipientAddress = recipient;
      } else {
        // Find recipient by username
        const [recipientUser] = await db.select()
          .from(users)
          .where(eq(users.username, recipient))
          .limit(1);

        if (!recipientUser) {
          return res.status(400).send("Recipient not found");
        }

        // Get recipient's wallet
        const [recipientWallet] = await db.select()
          .from(wallets)
          .where(and(
            eq(wallets.userId, recipientUser.id),
            eq(wallets.type, "daily")
          ))
          .limit(1);

        if (!recipientWallet) {
          return res.status(400).send("Recipient wallet not found");
        }

        recipientAddress = recipientWallet.address;
        recipientUserId = recipientUser.id;
      }

      // Create wallet instance
      const wallet = new ethers.Wallet(senderWallet.privateKey, provider);
      
      // Try to get test AVAX if balance is low
      await requestTestAVAX(senderWallet.address);

      // Get current balance and nonce
      const [balance, nonce] = await Promise.all([
        provider.getBalance(senderWallet.address),
        provider.getTransactionCount(senderWallet.address)
      ]);

      // Retry gas estimation with increasing buffer
      let fees;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          console.log(`Attempting gas estimation (attempt ${attempt}/3) for transaction:`, {
            from: senderWallet.address,
            to: recipientAddress,
            amount: amount.toString(),
            currentBalance: ethers.formatEther(balance)
          });

          fees = await estimateTransactionFees(
            senderWallet.address,
            recipientAddress,
            amount.toString()
          );
          console.log("Gas estimation successful:", {
            gasLimit: fees.gasLimit.toString(),
            maxFeePerGas: ethers.formatUnits(fees.maxFeePerGas, "gwei"),
            maxPriorityFeePerGas: ethers.formatUnits(fees.maxPriorityFeePerGas, "gwei"),
            totalFees: ethers.formatEther(fees.totalFees)
          });
          break;
        } catch (error: any) {
          console.error(`Gas estimation attempt ${attempt} failed:`, error);
          
          if (attempt === 3) {
            console.error("Gas estimation failed after 3 attempts:", error);
            return res.status(400).send(
              error.message.includes("insufficient funds")
                ? "Insufficient funds for gas estimation. Please ensure your wallet has enough AVAX for network fees."
                : "Failed to estimate transaction fees. Please try again."
            );
          }
          
          // Wait with exponential backoff before retrying
          await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
        }
      }

      // Calculate total required amount including gas fees
      const totalRequired = ethers.parseEther(amount.toString()) + fees.totalFees;
      if (balance < totalRequired) {
        const amountInAvax = amount.toString();
        const gasFeesInAvax = ethers.formatEther(fees.totalFees);
        const totalRequiredInAvax = ethers.formatEther(totalRequired);
        const balanceInAvax = ethers.formatEther(balance);
        
        return res.status(400).json({
          error: "INSUFFICIENT_FUNDS",
          message: "Insufficient funds for transaction",
          details: {
            amount: amountInAvax,
            estimatedGasFees: gasFeesInAvax,
            totalRequired: totalRequiredInAvax,
            currentBalance: balanceInAvax
          }
        });
      }

      // Create and sign transaction with proper nonce and gas settings
      const tx = await wallet.sendTransaction({
        to: recipientAddress,
        value: ethers.parseEther(amount.toString()),
        gasLimit: fees.gasLimit,
        maxFeePerGas: fees.maxFeePerGas,
        maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
        nonce: nonce
      });

      console.log("Transaction sent:", {
        hash: tx.hash,
        nonce,
        gasLimit: tx.gasLimit.toString(),
        maxFeePerGas: ethers.formatUnits(tx.maxFeePerGas || 0, "gwei"),
        maxPriorityFeePerGas: ethers.formatUnits(tx.maxPriorityFeePerGas || 0, "gwei")
      });

      // Wait for confirmation with timeout
      const receipt = await Promise.race([
        tx.wait(2), // Wait for 2 confirmations
        new Promise<never>((_, reject) => 
          setTimeout(() => reject(new Error("Transaction timeout")), 30000)
        )
      ]) as TransactionReceipt;

      if (!receipt || receipt.status === 0) {
        throw new Error("Transaction failed to be confirmed");
      }

      const customReceipt: CustomTransactionReceipt = {
        blockNumber: receipt.blockNumber,
        gasUsed: receipt.gasUsed,
        status: receipt.status,
        hash: tx.hash
      };

      // Record transaction in database
      await db.insert(transactions)
        .values({
          fromUserId: req.user.id,
          toUserId: recipientUserId || req.user.id, // If sending to address, use sender's ID
          amount: amount.toString(),
          type: "transfer",
          status: "completed",
          metadata: { 
            note,
            txHash: tx.hash,
            blockNumber: receipt.blockNumber,
            gasUsed: receipt.gasUsed.toString(),
            recipientAddress: useAddress ? recipientAddress : undefined
          }
        });

      res.json({ 
        success: true,
        txHash: tx.hash,
        blockNumber: receipt.blockNumber,
        gasUsed: receipt.gasUsed.toString()
      });
    } catch (error: any) {
      console.error("Transaction error:", error);
      
      // Handle specific error cases
      if (error.message.includes("insufficient funds")) {
        return res.status(400).send("Insufficient funds for transaction and gas fees");
      }
      if (error.message.includes("timeout")) {
        return res.status(408).send("Transaction confirmation timeout");
      }
      
      res.status(500).send("Failed to process transaction");
    }
  });

  // Pay Zakat
  app.post("/api/transactions/zakat", requireAuth, async (req, res) => {
    if (!isAuthenticated(req)) {
      return res.status(401).send("Not authenticated");
    }

    const { amount } = req.body;

    try {
      const [userWallet] = await db.select()
        .from(wallets)
        .where(and(
          eq(wallets.userId, req.user.id),
          eq(wallets.type, "daily")
        ))
        .limit(1);

      if (!userWallet || Number(userWallet.balance) < amount) {
        return res.status(400).send("Insufficient funds");
      }

      // Hard-coded Zakat collection address
      const ZAKAT_ADDRESS = "0x1234567890123456789012345678901234567890";

      // Create and sign transaction
      const wallet = new ethers.Wallet(userWallet.privateKey, provider);
      const tx = await wallet.sendTransaction({
        to: ZAKAT_ADDRESS,
        value: ethers.parseEther(amount.toString())
      });

      // Wait for confirmation
      await tx.wait();

      // Record transaction
      await db.insert(transactions)
        .values({
          fromUserId: req.user.id,
          toUserId: req.user.id, // Self-reference for Zakat
          amount: amount.toString(),
          type: "zakat",
          status: "completed",
          metadata: { txHash: tx.hash }
        });

      res.json({ success: true });
    } catch (error: any) {
      res.status(500).send(error.message);
    }
  });
}
