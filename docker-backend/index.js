const express = require("express");
const multer = require("multer");
const fs = require("fs").promises;
const Docker = require("dockerode");
const docker = new Docker();
const upload = multer();
const Gun = require('gun');
const os = require('os');
const { exec } = require('child_process');
const path = require('path');

// Utility to generate unique file names
const { v4: uuidv4 } = require('uuid');

// Create Express App
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Initialize Gun
const server = app.listen(3000, () => console.log("Server running on http://localhost:3000"));
const gun = Gun({
    web: server,
    peers: [
        'https://gun-manhattan.herokuapp.com/gun',
        'https://gun-us.herokuapp.com/gun',
        'https://gun-eu.herokuapp.com/gun',
        'https://gun-relay.herokuapp.com/gun',
        'https://gun-peer1.herokuapp.com/gun',
        'https://gun-peer2.herokuapp.com/gun', 
        'https://gun-asia.herokuapp.com/gun',
        'https://gun-au.herokuapp.com/gun',
        'https://gun-br.herokuapp.com/gun',
        'https://gun-ca.herokuapp.com/gun',
    ]
});

// Function to get GPU information (supports both NVIDIA and AMD GPUs)
function getGPUInfo() {
    return new Promise((resolve) => {
        // First try NVIDIA GPUs
        exec('nvidia-smi --query-gpu=name,memory.total --format=csv,noheader', (nvidiaError, nvidiaStdout) => {
            if (!nvidiaError) {
                const gpus = nvidiaStdout.trim().split('\n').map(line => {
                    const [name, memory] = line.split(',').map(s => s.trim());
                    return { name, memory, type: 'NVIDIA' };
                });
                return resolve(gpus);
            }

            // If NVIDIA fails, try AMD GPUs
            exec('rocm-smi --showproductname --showmeminfo vram', (amdError, amdStdout) => {
                if (amdError) {
                    console.error("No GPU info available:", amdError);
                    return resolve([]);
                }

                try {
                    const lines = amdStdout.trim().split('\n');
                    const gpus = [];
                    let currentGpu = {};

                    lines.forEach(line => {
                        if (line.includes('GPU')) {
                            if (currentGpu.name) {
                                gpus.push(currentGpu);
                            }
                            currentGpu = { type: 'AMD' };
                        } else if (line.includes('Product Name')) {
                            currentGpu.name = line.split(':')[1].trim();
                        } else if (line.includes('VRAM')) {
                            currentGpu.memory = line.split(':')[1].trim();
                        }
                    });

                    if (currentGpu.name) {
                        gpus.push(currentGpu);
                    }

                    resolve(gpus);
                } catch (parseError) {
                    console.error("Error parsing AMD GPU info:", parseError);
                    resolve([]);
                }
            });
        });
    });
}

// Function to get system resources
async function getSystemResources() {
    const cpus = os.cpus().length;
    const ram = os.totalmem();
    const gpus = await getGPUInfo();
    return { cpus, ram, gpus };
}

const NETWORK_ROOM_ID = 'networkroomid'; // Room ID for network resources

// Function to broadcast resources
async function broadcastResources() {
    const resources = await getSystemResources();
    gun.get(NETWORK_ROOM_ID).get(os.hostname()).put({
        host: os.hostname(),
        cpus: resources.cpus,
        ram: resources.ram, // in bytes
        gpuList: JSON.stringify(resources.gpus), // Storing GPU info as JSON string
        timestamp: Date.now(),
    });
    console.log(`Broadcasted resources for host: ${os.hostname()}`);
}

// Broadcast resources every 5 seconds
setInterval(broadcastResources, 5000);

// Listen to execution requests specific to this host
const EXECUTION_ROOM = `executionRequests_${os.hostname()}`; // Unique room per host
console.log(`Listening to execution room: ${EXECUTION_ROOM}`);

gun.get(EXECUTION_ROOM).map().on(async (request, key) => {
    if (!request || request.processed || !request.code) return;

    console.log(`Received execution request with key: ${key}`);

    const { code, clientRoomId, resources } = request;
    const cpus = resources?.cpus || 1; // Default to 1 CPU if not specified
    const ram = (resources?.ram || 512 * 1024 * 1024); // Default to 512MB if not specified

    console.log(`Executing code with CPUs: ${cpus}, RAM: ${ram} bytes`);

    // Generate a unique temporary file path
    const uniqueId = uuidv4();
    const filePath = path.join(os.tmpdir(), `code_${uniqueId}.py`);

    try {
        // Update status to 'running'
        await gun.get(clientRoomId).put({ status: 'running', timestamp: Date.now() });
        console.log(`Status updated to 'running' for clientRoomId: ${clientRoomId}`);

        // Save the code to a unique temporary file
        await fs.writeFile(filePath, code, { encoding: 'utf8' });
        console.log(`Code written to temporary file: ${filePath}`);

        // Configure Docker resources
        const container = await docker.createContainer({
            Image: "python:alpine", // Updated to Python 3.9 for better compatibility
            Cmd: ["python3", "/app/code.py"],
            AttachStdout: true,
            AttachStderr: true,
            HostConfig: {
                Memory: ram,
                NanoCPUs: cpus * 1e9, // Docker expects CPU quota in nano CPUs
                Binds: [`${filePath}:/app/code.py:ro`], // Mounted as read-only
            },
        });

        console.log(`Docker container created: ${container.id}`);

        await container.start();
        console.log(`Docker container started: ${container.id}`);

        // Capture logs
        const logsStream = await container.logs({ stdout: true, stderr: true, follow: true });
        let output = "";

        logsStream.on("data", data => {
            output += data.toString();
        });

        // Wait for the container to finish execution
        await container.wait();
        console.log(`Docker container execution completed: ${container.id}`);

        await container.remove();
        console.log(`Docker container removed: ${container.id}`);

        // Clean up the temporary file
        try {
            await fs.unlink(filePath);
            console.log(`Temporary file deleted: ${filePath}`);
        } catch (unlinkError) {
            if (unlinkError.code === 'ENOENT') {
                console.warn(`Temporary file not found for deletion: ${filePath}`);
            } else {
                console.error(`Error deleting temporary file: ${unlinkError.message}`);
            }
        }

        // Update status to 'completed' and send output
        await gun.get(clientRoomId).put({ status: 'completed', output, timestamp: Date.now() });
        console.log(`Status updated to 'completed' for clientRoomId: ${clientRoomId}`);

        // Mark the request as processed
        await gun.get(EXECUTION_ROOM).get(key).put({ processed: true });
        console.log(`Marked request as processed with key: ${key}`);

    } catch (error) {
        console.error(`Error during code execution: ${error.message}`);

        // Clean up the temporary file if it exists
        try {
            await fs.unlink(filePath);
            console.log(`Temporary file deleted after error: ${filePath}`);
        } catch (unlinkError) {
            if (unlinkError.code === 'ENOENT') {
                console.warn(`Temporary file not found for deletion after error: ${filePath}`);
            } else {
                console.error(`Error deleting temporary file after error: ${unlinkError.message}`);
            }
        }

        // Update status to 'error' and send error message
        await gun.get(clientRoomId).put({ status: 'error', output: error.message, timestamp: Date.now() });
        console.log(`Status updated to 'error' for clientRoomId: ${clientRoomId}`);

        // Mark the request as processed
        await gun.get(EXECUTION_ROOM).get(key).put({ processed: true });
        console.log(`Marked request as processed with key: ${key}`);
    }
});

// Optional: Implement the /run-code endpoint if needed
app.post("/run-code", upload.single("file"), async (req, res) => {
    let code = req.body.code;

    // Generate a unique temporary file path
    const uniqueId = uuidv4();
    const filePath = path.join(os.tmpdir(), `code_${uniqueId}.py`);

    try {
        // Save the code to a unique temporary file
        if (req.file) {
            await fs.writeFile(filePath, req.file.buffer.toString(), { encoding: 'utf8' });
        } else if (code) {
            await fs.writeFile(filePath, code, { encoding: 'utf8' });
        } else {
            return res.status(400).send({ output: "No code provided" });
        }

        console.log(`Code written to temporary file: ${filePath}`);

        // Create and start the Docker container
        const container = await docker.createContainer({
            Image: "python:alpine",
            Cmd: ["python3", "/app/code.py"],
            AttachStdout: true,
            AttachStderr: true,
            HostConfig: {
                Memory: 4 * 1024 * 1024 * 1024, // 4GB RAM
                NanoCPUs: 4 * 1e9,              // 4 CPUs
                Binds: [`${filePath}:/app/code.py:ro`], // Mounted as read-only
            },
        });

        console.log(`Docker container created: ${container.id}`);

        await container.start();
        console.log(`Docker container started: ${container.id}`);

        // Capture logs
        const logsStream = await container.logs({ stdout: true, stderr: true, follow: true });
        let output = "";

        logsStream.on("data", data => {
            output += data.toString();
        });

        // Wait for the container to finish execution
        await container.wait();
        console.log(`Docker container execution completed: ${container.id}`);

        await container.remove();
        console.log(`Docker container removed: ${container.id}`);

        // Clean up the temporary file
        try {
            await fs.unlink(filePath);
            console.log(`Temporary file deleted: ${filePath}`);
        } catch (unlinkError) {
            if (unlinkError.code === 'ENOENT') {
                console.warn(`Temporary file not found for deletion: ${filePath}`);
            } else {
                console.error(`Error deleting temporary file: ${unlinkError.message}`);
            }
        }

        res.send({ output });

    } catch (error) {
        console.error(`Error during /run-code execution: ${error.message}`);

        // Clean up the temporary file if it exists
        try {
            await fs.unlink(filePath);
            console.log(`Temporary file deleted after error: ${filePath}`);
        } catch (unlinkError) {
            if (unlinkError.code === 'ENOENT') {
                console.warn(`Temporary file not found for deletion after error: ${filePath}`);
            } else {
                console.error(`Error deleting temporary file after error: ${unlinkError.message}`);
            }
        }

        res.status(500).send({ output: error.message });
    }
});
