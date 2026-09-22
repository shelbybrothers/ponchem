// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @dev A minimal ERC20 for the payment tests, with switches that make it misbehave the way real tokens do.
contract MockToken {
    string public name = "Mock PONCHEM";
    string public symbol = "MPON";
    uint8 public decimals = 18;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    /// 0 returns true, 1 returns nothing (USDT style), 2 returns false, 3 reverts, 4 returns a short word
    uint8 public mode;

    function setMode(uint8 m) external {
        mode = m;
    }

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        if (mode == 3) revert("mock: no");
        if (mode == 2) return false;
        uint256 a = allowance[from][msg.sender];
        require(a >= amount, "mock: allowance");
        require(balanceOf[from] >= amount, "mock: balance");
        allowance[from][msg.sender] = a - amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        if (mode == 1) {
            assembly {
                return(0, 0)
            }
        }
        if (mode == 4) {
            assembly {
                mstore(0, 1)
                return(0, 8)
            }
        }
        return true;
    }
}

/// @dev A receiver that refuses ETH until told otherwise, then withdraws.
contract Refuser {
    bool public open;

    function allow() external {
        open = true;
    }

    receive() external payable {
        require(open, "closed");
    }

    function call(address to, bytes calldata data, uint256 value) external returns (bytes memory out) {
        bool ok;
        (ok, out) = to.call{value: value}(data);
        if (!ok) {
            assembly {
                revert(add(out, 32), mload(out))
            }
        }
    }
}

/// @dev A receiver that burns all the gas it is given.
contract GasBurner {
    receive() external payable {
        while (true) {}
    }
}

/// @dev A receiver that answers with a very large return blob (the return-bomb).
contract Bomber {
    receive() external payable {
        assembly {
            return(0, 144000)
        }
    }
}
